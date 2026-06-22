//! Generic sherpa-onnx engine loading and single-chunk synthesis.
//!
//! Owns the loaded [`SherpaTtsEngine`] (rebuilt when the requested thread
//! count changes), the text sanitization applied before native tokenization,
//! and the saved-audiobook synthesis sink: [`synthesize_to_file`], which writes
//! validated WAV chunks atomically into the audiobook cache.
//!
//! Rust notes for a JS reader: `spawn_blocking` runs CPU-heavy work on a
//! background thread pool (like a Web Worker) so the async runtime that handles
//! UI messages isn't blocked. A `Mutex` is a lock guaranteeing one thread
//! touches the engine at a time; `.lock()` is like awaiting that lock.

use std::fs;
use std::path::Path;
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use sherpa_onnx::{
    write as write_wav_file, GeneratedAudio, GenerationConfig, OfflineTts, OfflineTtsConfig,
    OfflineTtsKokoroModelConfig, OfflineTtsModelConfig, OfflineTtsVitsModelConfig,
};

use super::cache::wav_info;
use super::file_commit::commit_staged_file;
use super::models::{model_definition, ModelDefinition, SherpaModelFamily};
use super::paths::{audio_duration_sec, resolve_model_dir};
use crate::native_tts::platform::resolve_thread_count;

/// A loaded sherpa-onnx model plus the settings it was built with. Kept
/// alive in shared state and reused across syntheses; rebuilt only when the
/// requested thread count differs (see [`ensure_engine`]).
pub(crate) struct SherpaTtsEngine {
    pub(super) tts: OfflineTts,
    pub(super) model: &'static ModelDefinition,
    pub(super) model_dir: std::path::PathBuf,
    pub(super) num_threads: i32,
}

/// Timing/size result of writing one synthesized chunk to a file.
pub(super) struct FileSynthesisResult {
    pub(super) generate_ms: u128,
    pub(super) audio_duration_sec: f32,
    pub(super) wav_bytes: usize,
}

/// Return a ready engine from the shared slot, (re)building it if absent or if
/// the thread count changed. `guard` is the locked `Option<engine>`; the
/// returned `&SherpaTtsEngine` borrows from it for the rest of the call.
pub(super) fn ensure_engine<'a>(
    app: &tauri::AppHandle,
    guard: &'a mut Option<SherpaTtsEngine>,
    model_id: &str,
    thread_count: Option<i32>,
) -> Result<&'a SherpaTtsEngine, String> {
    let model = model_definition(model_id)?;
    let requested_threads = resolve_thread_count(thread_count);
    // Rebuild only when there's no engine yet, or the desired thread count
    // differs from the loaded one (changing threads needs a fresh engine).
    let should_create = guard
        .as_ref()
        .map(|engine| engine.num_threads != requested_threads || engine.model.id != model.id)
        .unwrap_or(true);

    if should_create {
        let model_dir = resolve_model_dir(app, model)?;
        *guard = Some(SherpaTtsEngine {
            tts: create_engine(model, &model_dir, requested_threads)?,
            model,
            model_dir,
            num_threads: requested_threads,
        });
    }

    guard
        .as_ref()
        .ok_or_else(|| "Native TTS engine unavailable".to_string())
}

/// Synthesize `text` straight to `output_path` (for saving). Writes to a temp
/// file, validates it parses as WAV, then atomically renames into place so a
/// crash mid-write never leaves a corrupt chunk in the cache.
pub(super) fn synthesize_to_file(
    engine: &SherpaTtsEngine,
    text: &str,
    voice: &str,
    speed: f32,
    output_path: &Path,
) -> Result<FileSynthesisResult, String> {
    let started = Instant::now();
    if let Some(parent) = output_path.parent() {
        fs::create_dir_all(parent).map_err(|err| {
            format!(
                "Failed to create native audiobook chunk dir {}: {err}",
                parent.display()
            )
        })?;
    }
    let temp_path = output_path.with_extension(format!(
        "{}.tmp",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|err| format!("System clock error: {err}"))?
            .as_nanos()
    ));

    // A chunk whose text is empty after sanitization (e.g. a paragraph of only
    // emoji or other dropped symbols) has nothing to synthesize. Failing here
    // would abort the whole save and wedge resume on the same chunk forever, so
    // instead write a short silent WAV: the playback timeline stays contiguous
    // and the job completes. `fallback_duration_sec` guards against a generated
    // WAV whose header rounds its duration down to zero.
    let fallback_duration_sec = match generate_audio(engine, text, voice, speed)? {
        Some(audio) => {
            let duration = audio_duration_sec(audio.samples().len(), audio.sample_rate());
            if !audio.save(&temp_path.display().to_string()) {
                let _ = fs::remove_file(&temp_path);
                return Err(format!(
                    "sherpa-onnx failed to write generated WAV {}",
                    temp_path.display()
                ));
            }
            duration
        }
        None => {
            let sample_rate = engine.tts.sample_rate();
            log::warn!(
                "Audiobook chunk had no speakable text after sanitization; writing {SILENT_PLACEHOLDER_SEC}s silent placeholder at {} ({sample_rate} Hz)",
                output_path.display(),
            );
            write_silent_placeholder(&temp_path, sample_rate)?
        }
    };

    // Sanity-check the written file actually parses before committing it.
    let Some(info) = wav_info(&temp_path) else {
        let _ = fs::remove_file(&temp_path);
        return Err(format!("Generated invalid WAV {}", temp_path.display()));
    };
    commit_staged_file(&temp_path, output_path, "generated WAV")?;

    Ok(FileSynthesisResult {
        generate_ms: started.elapsed().as_millis(),
        audio_duration_sec: info.audio_duration_sec.max(fallback_duration_sec),
        wav_bytes: info.wav_bytes,
    })
}

/// Length of the silent WAV written for a chunk with no speakable text. Short
/// enough to be an imperceptible gap, but nonzero so the WAV is a valid,
/// indexable chunk (the playback index rejects zero-duration chunks).
const SILENT_PLACEHOLDER_SEC: f64 = 0.25;

/// Write [`SILENT_PLACEHOLDER_SEC`] of silence to `path` and return its exact
/// duration in seconds.
///
/// Uses sherpa-onnx's own WAV writer — the same one [`OfflineTts`] generation
/// goes through — so the file's encoding (mono 16-bit PCM at the engine's
/// sample rate) is byte-identical to generated chunks by construction. That
/// keeps its `fmt ` block matching theirs, which single-track export
/// concatenation requires. Silence is simply a run of zero samples.
fn write_silent_placeholder(path: &Path, sample_rate: i32) -> Result<f32, String> {
    if sample_rate <= 0 {
        return Err(format!(
            "Engine reported a non-positive sample rate ({sample_rate}); cannot write a silent placeholder for {}",
            path.display()
        ));
    }
    let frame_count = (sample_rate as f64 * SILENT_PLACEHOLDER_SEC).round() as usize;
    let silence = vec![0f32; frame_count];
    if !write_wav_file(&path.display().to_string(), &silence, sample_rate) {
        return Err(format!(
            "sherpa-onnx failed to write silent placeholder WAV {}",
            path.display()
        ));
    }
    Ok(frame_count as f32 / sample_rate as f32)
}

/// Run sherpa-onnx inference for one piece of text. Normalizes speed, maps the
/// voice name to a speaker id, sanitizes the text, and asks the engine to
/// generate. Returns `Ok(None)` when the text is empty after sanitization (the
/// chunk has nothing speakable, so the caller writes a silent placeholder rather
/// than failing the save); errors only when generation itself fails.
fn generate_audio(
    engine: &SherpaTtsEngine,
    text: &str,
    voice: &str,
    speed: f32,
) -> Result<Option<GeneratedAudio>, String> {
    let speed = if speed.is_finite() && speed > 0.0 {
        speed
    } else {
        1.0
    };
    let generation = GenerationConfig {
        speed,
        sid: engine.model.speaker_id(voice)?,
        ..Default::default()
    };

    let mut sanitized = sanitize_tts_text(text);
    // Year/number expansion is English-only; gate it so non-English models
    // (e.g. Arabic Piper) never get Western number words in their synthesis text.
    if engine.model.expands_english_years() {
        sanitized = normalize_year_like_numbers(&sanitized);
    }
    if sanitized.trim().is_empty() {
        return Ok(None);
    }

    // The last arg is an optional progress callback; `None::<fn...>` means none.
    engine
        .tts
        .generate_with_config(&sanitized, &generation, None::<fn(&[f32], f32) -> bool>)
        .map(Some)
        .ok_or_else(|| "sherpa-onnx failed to synthesize audio".to_string())
}

/// Clean Unicode text before model-specific tokenization: normalize
/// smart quotes/dashes/ellipses to ASCII, fold all whitespace to single spaces,
/// drop zero-width and control characters, and drop non-BMP symbols (emoji) that
/// can trip native tokenization. Language-specific normalization (e.g. English
/// year expansion) is applied separately by the caller, not here.
fn sanitize_tts_text(text: &str) -> String {
    let mut cleaned = String::with_capacity(text.len());
    let mut previous_was_space = false;

    for ch in text.chars() {
        let mapped = match ch {
            '\u{2018}' | '\u{2019}' | '\u{201A}' | '\u{201B}' => '\'',
            '\u{201C}' | '\u{201D}' | '\u{201E}' | '\u{201F}' => '"',
            '\u{2010}' | '\u{2011}' | '\u{2012}' | '\u{2013}' | '\u{2014}' | '\u{2015}'
            | '\u{2212}' => '-',
            '\u{2026}' => {
                cleaned.push_str("...");
                previous_was_space = false;
                continue;
            }
            '\u{00A0}'
            | '\u{1680}'
            | '\u{2000}'..='\u{200A}'
            | '\u{202F}'
            | '\u{205F}'
            | '\u{3000}' => ' ',
            '\u{200B}' | '\u{200C}' | '\u{200D}' | '\u{2060}' | '\u{FEFF}' => continue,
            _ => ch,
        };

        // Collapse consecutive whitespace into one space.
        if mapped.is_whitespace() {
            if !previous_was_space {
                cleaned.push(' ');
                previous_was_space = true;
            }
            continue;
        }

        // Native espeak-backed paths are most reliable with BMP text.
        // Emoji and other non-BMP symbols can trip native tokenization, so
        // drop them before handing text to sherpa-onnx.
        if mapped.is_control() || mapped as u32 > 0xFFFF {
            continue;
        }

        cleaned.push(mapped);
        previous_was_space = false;
    }

    cleaned.trim().to_string()
}

/// Expand standalone four-digit years into the phrasing eSpeak/Kokoro usually
/// needs for natural historical dates: `1984` becomes `nineteen eighty four`.
/// This intentionally runs only on the synthesis copy, leaving source chunks,
/// highlighting, search, bundle metadata, and cache identity unchanged.
fn normalize_year_like_numbers(text: &str) -> String {
    let chars = text.chars().collect::<Vec<_>>();
    let mut normalized = String::with_capacity(text.len());
    let mut index = 0usize;

    while index < chars.len() {
        let ch = chars[index];
        if !ch.is_ascii_digit() {
            normalized.push(ch);
            index += 1;
            continue;
        }

        let start = index;
        while index < chars.len() && chars[index].is_ascii_digit() {
            index += 1;
        }
        let token = chars[start..index].iter().collect::<String>();
        let previous = start.checked_sub(1).map(|value| chars[value]);
        let next = chars.get(index).copied();
        let after_next = chars.get(index + 1).copied();
        let year_words = (token.len() == 4
            && is_prose_year_left(previous)
            && is_prose_year_right(next, after_next))
        .then(|| token.parse::<u16>().ok().and_then(year_to_words))
        .flatten();

        if let Some(words) = year_words {
            normalized.push_str(&words);
        } else {
            normalized.push_str(&token);
        }
    }

    normalized
}

/// A four-digit run reads as a spoken year only when its left side looks like
/// prose. Letters/digits (identifiers), a decimal point or currency/math symbol
/// (a measured amount), or a hyphen (a page/number range) all suppress it.
fn is_prose_year_left(previous: Option<char>) -> bool {
    match previous {
        None => true,
        Some(ch) if ch.is_whitespace() => true,
        Some('(') | Some('[') | Some('{') | Some('"') | Some('\'') => true,
        _ => false,
    }
}

/// Mirror of [`is_prose_year_left`] for the right side. A following decimal or
/// digit-grouping comma (`1984.5`, `1984,000`) marks a number, not a year, so
/// only whitespace or closing/sentence punctuation keeps the year reading.
fn is_prose_year_right(next: Option<char>, after_next: Option<char>) -> bool {
    let followed_by_digit = matches!(after_next, Some(ch) if ch.is_ascii_digit());
    match next {
        None => true,
        Some(ch) if ch.is_whitespace() => true,
        // A decimal point or thousands comma only counts as a boundary when it
        // is not gluing the run to more digits.
        Some('.') | Some(',') => !followed_by_digit,
        Some(')') | Some(']') | Some('}') | Some('"') | Some('\'') | Some(';') | Some(':')
        | Some('!') | Some('?') => true,
        _ => false,
    }
}

fn year_to_words(year: u16) -> Option<String> {
    if !(1000..=2099).contains(&year) {
        return None;
    }

    if year == 1000 {
        return Some("one thousand".into());
    }
    if year < 1010 {
        return Some(format!("one thousand {}", below_hundred_words(year % 100)?));
    }
    if year < 2000 {
        let century = year / 100;
        let remainder = year % 100;
        return Some(if remainder == 0 {
            format!("{} hundred", below_hundred_words(century)?)
        } else if remainder < 10 {
            format!(
                "{} oh {}",
                below_hundred_words(century)?,
                below_hundred_words(remainder)?
            )
        } else {
            format!(
                "{} {}",
                below_hundred_words(century)?,
                below_hundred_words(remainder)?
            )
        });
    }

    let remainder = year - 2000;
    Some(if remainder == 0 {
        "two thousand".into()
    } else if remainder < 10 {
        format!("two thousand {}", below_hundred_words(remainder)?)
    } else {
        format!("twenty {}", below_hundred_words(remainder)?)
    })
}

/// Spell out 0–99 by composing a ones word with an optional tens word, e.g.
/// `84` -> `"eighty four"`. Returns `None` for anything ≥ 100. Used only to build
/// the spoken year phrasing in [`year_to_words`].
fn below_hundred_words(value: u16) -> Option<String> {
    const ONES: [&str; 20] = [
        "zero", "one", "two", "three", "four", "five", "six", "seven", "eight",
        "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen",
        "sixteen", "seventeen", "eighteen", "nineteen",
    ];
    // Indices 0/1 are unused: 0–19 are handled directly above, and English has no
    // distinct tens word below twenty.
    const TENS: [&str; 10] = [
        "", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty",
        "ninety",
    ];

    match value {
        0..=19 => Some(ONES[value as usize].to_string()),
        20..=99 => {
            let tens = TENS[(value / 10) as usize];
            let ones = (value % 10) as usize;
            Some(if ones == 0 {
                tens.to_string()
            } else {
                format!("{tens} {}", ONES[ones])
            })
        }
        _ => None,
    }
}

/// Build a short, sanitized preview (≤140 chars, "..." if truncated) of a
/// chunk's text for progress/diagnostics messages.
pub(super) fn text_preview(text: &str) -> String {
    let sanitized = sanitize_tts_text(text);
    let mut preview = sanitized.chars().take(140).collect::<String>();
    if sanitized.chars().count() > 140 {
        preview.push_str("...");
    }
    preview
}

/// Construct one sherpa-onnx engine from catalog metadata.
fn create_engine(
    model: &ModelDefinition,
    model_dir: &Path,
    thread_count: i32,
) -> Result<OfflineTts, String> {
    let mut model_config = OfflineTtsModelConfig {
        num_threads: thread_count,
        provider: Some("cpu".into()),
        ..Default::default()
    };

    match model.family {
        SherpaModelFamily::Kokoro => {
            let lexicon = [
                model_dir.join("lexicon-us-en.txt"),
                model_dir.join("lexicon-zh.txt"),
            ]
            .iter()
            .filter(|path| path.is_file())
            .map(|path| path.display().to_string())
            .collect::<Vec<_>>()
            .join(",");
            model_config.kokoro = OfflineTtsKokoroModelConfig {
                model: Some(model_dir.join(model.model_file).display().to_string()),
                voices: Some(model_dir.join("voices.bin").display().to_string()),
                tokens: Some(model_dir.join("tokens.txt").display().to_string()),
                data_dir: Some(model_dir.join("espeak-ng-data").display().to_string()),
                lexicon: (!lexicon.is_empty()).then_some(lexicon),
                lang: Some("en-us".into()),
                ..Default::default()
            };
        }
        SherpaModelFamily::Vits => {
            model_config.vits = OfflineTtsVitsModelConfig {
                model: Some(model_dir.join(model.model_file).display().to_string()),
                tokens: Some(model_dir.join("tokens.txt").display().to_string()),
                data_dir: Some(model_dir.join("espeak-ng-data").display().to_string()),
                ..Default::default()
            };
        }
    }

    let config = OfflineTtsConfig {
        model: model_config,
        max_num_sentences: 1,
        ..Default::default()
    };
    OfflineTts::create(&config)
        .ok_or_else(|| format!("Failed to create {} engine", model.display_name))
}

#[cfg(test)]
mod tests {
    use super::*;
    use super::super::models::{model_definition, DEFAULT_MODEL_ID};

    #[test]
    fn silent_placeholder_passes_wav_validation() {
        // The placeholder written for an empty-after-sanitization chunk must parse
        // as a valid, nonzero-duration WAV through the same reader the save commit
        // and playback index use, or it would just move the failure downstream.
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        let path = std::env::temp_dir().join(format!("papercut-silent-{nonce}.wav"));
        let duration = write_silent_placeholder(&path, 24_000).expect("write silent placeholder");
        assert!(duration > 0.0 && duration.is_finite());

        let info = wav_info(&path).expect("silent placeholder must parse as WAV");
        assert!(info.audio_duration_sec > 0.0);
        let _ = fs::remove_file(&path);
    }

    #[test]
    fn year_expansion_rewrites_standalone_years() {
        assert_eq!(
            normalize_year_like_numbers("Written in 1984."),
            "Written in nineteen eighty four."
        );
        assert_eq!(
            normalize_year_like_numbers("First published: 1898"),
            "First published: eighteen ninety eight"
        );
        assert_eq!(
            normalize_year_like_numbers("Updated in 2026"),
            "Updated in twenty twenty six"
        );
    }

    #[test]
    fn year_expansion_rewrites_wrapped_and_punctuated_years() {
        assert_eq!(
            normalize_year_like_numbers("Released (1984) widely."),
            "Released (nineteen eighty four) widely."
        );
        assert_eq!(
            normalize_year_like_numbers("In 1984, sales rose."),
            "In nineteen eighty four, sales rose."
        );
    }

    #[test]
    fn year_expansion_leaves_non_year_numbers_alone() {
        assert_eq!(
            normalize_year_like_numbers("See pp. 123-124 and item A1984."),
            "See pp. 123-124 and item A1984."
        );
        assert_eq!(
            normalize_year_like_numbers("The code 9876 is not a supported year."),
            "The code 9876 is not a supported year."
        );
    }

    #[test]
    fn year_expansion_skips_quantities_and_ranges() {
        // Decimals and digit-grouping commas are measured numbers, not years.
        assert_eq!(
            normalize_year_like_numbers("It cost 3.1984 per unit."),
            "It cost 3.1984 per unit."
        );
        assert_eq!(
            normalize_year_like_numbers("A 1984.50 balance and 1984,000 total."),
            "A 1984.50 balance and 1984,000 total."
        );
        // Currency, percentages, and hyphen ranges all keep their digits.
        assert_eq!(
            normalize_year_like_numbers("Paid $1984 at 1984% over pages 1900-2000."),
            "Paid $1984 at 1984% over pages 1900-2000."
        );
    }

    #[test]
    fn sanitizer_does_not_expand_years_by_itself() {
        // Year expansion is gated per-model in `generate_audio`, never inside the
        // shared sanitizer, so non-English models keep their original numbers.
        assert_eq!(sanitize_tts_text("Written in 1984."), "Written in 1984.");
    }

    #[test]
    fn only_english_models_expand_years() {
        assert!(model_definition(DEFAULT_MODEL_ID).unwrap().expands_english_years());
        assert!(!model_definition("sherpa-onnx/vits-piper-ar_JO-kareem-medium")
            .unwrap()
            .expands_english_years());
    }
}
