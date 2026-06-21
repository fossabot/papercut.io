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
    GeneratedAudio, GenerationConfig, OfflineTts, OfflineTtsConfig, OfflineTtsKokoroModelConfig,
    OfflineTtsModelConfig, OfflineTtsVitsModelConfig,
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
    let audio = generate_audio(engine, text, voice, speed)?;
    let sample_rate = audio.sample_rate();
    let audio_duration_sec = audio_duration_sec(audio.samples().len(), sample_rate);
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
    let temp_path_string = temp_path.display().to_string();
    if !audio.save(&temp_path_string) {
        let _ = fs::remove_file(&temp_path);
        return Err(format!(
            "sherpa-onnx failed to write generated WAV {}",
            temp_path.display()
        ));
    }
    // Sanity-check the written file actually parses before committing it.
    let Some(info) = wav_info(&temp_path) else {
        let _ = fs::remove_file(&temp_path);
        return Err(format!("Generated invalid WAV {}", temp_path.display()));
    };
    commit_staged_file(&temp_path, output_path, "generated WAV")?;

    Ok(FileSynthesisResult {
        generate_ms: started.elapsed().as_millis(),
        audio_duration_sec: info.audio_duration_sec.max(audio_duration_sec),
        wav_bytes: info.wav_bytes,
    })
}

/// Run sherpa-onnx inference for one piece of text. Normalizes speed, maps the
/// voice name to a speaker id, sanitizes the text, and asks the engine to
/// generate. Errors if the text is empty after sanitization or generation fails.
fn generate_audio(
    engine: &SherpaTtsEngine,
    text: &str,
    voice: &str,
    speed: f32,
) -> Result<GeneratedAudio, String> {
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
        return Err("TTS chunk became empty after sanitization".into());
    }

    // The last arg is an optional progress callback; `None::<fn...>` means none.
    engine
        .tts
        .generate_with_config(&sanitized, &generation, None::<fn(&[f32], f32) -> bool>)
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

fn below_hundred_words(value: u16) -> Option<&'static str> {
    match value {
        0 => Some("zero"),
        1 => Some("one"),
        2 => Some("two"),
        3 => Some("three"),
        4 => Some("four"),
        5 => Some("five"),
        6 => Some("six"),
        7 => Some("seven"),
        8 => Some("eight"),
        9 => Some("nine"),
        10 => Some("ten"),
        11 => Some("eleven"),
        12 => Some("twelve"),
        13 => Some("thirteen"),
        14 => Some("fourteen"),
        15 => Some("fifteen"),
        16 => Some("sixteen"),
        17 => Some("seventeen"),
        18 => Some("eighteen"),
        19 => Some("nineteen"),
        20 => Some("twenty"),
        21 => Some("twenty one"),
        22 => Some("twenty two"),
        23 => Some("twenty three"),
        24 => Some("twenty four"),
        25 => Some("twenty five"),
        26 => Some("twenty six"),
        27 => Some("twenty seven"),
        28 => Some("twenty eight"),
        29 => Some("twenty nine"),
        30 => Some("thirty"),
        31 => Some("thirty one"),
        32 => Some("thirty two"),
        33 => Some("thirty three"),
        34 => Some("thirty four"),
        35 => Some("thirty five"),
        36 => Some("thirty six"),
        37 => Some("thirty seven"),
        38 => Some("thirty eight"),
        39 => Some("thirty nine"),
        40 => Some("forty"),
        41 => Some("forty one"),
        42 => Some("forty two"),
        43 => Some("forty three"),
        44 => Some("forty four"),
        45 => Some("forty five"),
        46 => Some("forty six"),
        47 => Some("forty seven"),
        48 => Some("forty eight"),
        49 => Some("forty nine"),
        50 => Some("fifty"),
        51 => Some("fifty one"),
        52 => Some("fifty two"),
        53 => Some("fifty three"),
        54 => Some("fifty four"),
        55 => Some("fifty five"),
        56 => Some("fifty six"),
        57 => Some("fifty seven"),
        58 => Some("fifty eight"),
        59 => Some("fifty nine"),
        60 => Some("sixty"),
        61 => Some("sixty one"),
        62 => Some("sixty two"),
        63 => Some("sixty three"),
        64 => Some("sixty four"),
        65 => Some("sixty five"),
        66 => Some("sixty six"),
        67 => Some("sixty seven"),
        68 => Some("sixty eight"),
        69 => Some("sixty nine"),
        70 => Some("seventy"),
        71 => Some("seventy one"),
        72 => Some("seventy two"),
        73 => Some("seventy three"),
        74 => Some("seventy four"),
        75 => Some("seventy five"),
        76 => Some("seventy six"),
        77 => Some("seventy seven"),
        78 => Some("seventy eight"),
        79 => Some("seventy nine"),
        80 => Some("eighty"),
        81 => Some("eighty one"),
        82 => Some("eighty two"),
        83 => Some("eighty three"),
        84 => Some("eighty four"),
        85 => Some("eighty five"),
        86 => Some("eighty six"),
        87 => Some("eighty seven"),
        88 => Some("eighty eight"),
        89 => Some("eighty nine"),
        90 => Some("ninety"),
        91 => Some("ninety one"),
        92 => Some("ninety two"),
        93 => Some("ninety three"),
        94 => Some("ninety four"),
        95 => Some("ninety five"),
        96 => Some("ninety six"),
        97 => Some("ninety seven"),
        98 => Some("ninety eight"),
        99 => Some("ninety nine"),
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
