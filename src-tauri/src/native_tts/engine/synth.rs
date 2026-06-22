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
    // Year expansion, roman-numeral expansion, and semicolon/decimal cleanup are
    // English-only; gate them so non-English models (e.g. Arabic Piper) never get
    // Western number words or English punctuation rewrites in their synthesis text.
    if engine.model.english_text_normalization() {
        sanitized = normalize_english_synthesis_text(&sanitized);
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

/// Compose the English-only synthesis-text rewrites in the order their guards
/// expect: roman-numeral expansion first (operates on letters), then decimal-dot
/// repair (so the following year pass never mistakes a decimal fraction for a
/// year), then year expansion, then clause-punctuation softening last.
///
/// Like [`normalize_year_like_numbers`], every step runs only on the synthesis
/// copy, leaving source chunks, highlighting, search, bundle metadata, and cache
/// identity untouched. It is gated per-model by `english_text_normalization()`.
fn normalize_english_synthesis_text(text: &str) -> String {
    let with_romans = expand_section_roman_numerals(text);
    let collapsed = collapse_decimal_dots(&with_romans);
    let with_years = normalize_year_like_numbers(&collapsed);
    soften_clause_punctuation(&with_years)
}

/// Section keywords whose following uppercase roman numeral reads as a number.
/// Restricting expansion to these prefixes avoids rewriting the pronoun "I",
/// the grade "C", "X marks the spot", and other legitimate standalone letters.
const SECTION_WORDS: [&str; 10] = [
    "chapter", "part", "section", "book", "act", "volume", "appendix", "article",
    "canto", "scene",
];

/// Expand an uppercase roman numeral that directly follows a section keyword into
/// its cardinal digits, e.g. `Chapter IV` -> `Chapter 4`, `Part VII` -> `Part 7`.
/// eSpeak's own roman handling is inconsistent (it can announce "roman one"), so
/// we feed it plain digits instead. Post-`sanitize_tts_text` text is single-spaced
/// with no newlines, so splitting on a single space is sufficient and lossless.
///
/// The keyword must be capitalized to match. Several keywords (`book`, `act`,
/// `part`, `section`) are also common words, and a lowercase one is usually prose
/// followed by the pronoun "I" (`the book I read`); requiring a capital keeps the
/// match to genuine section references and avoids rewriting that "I" to "1". The
/// trade-off is that a lowercase reference (`in chapter IV`) is left for eSpeak.
fn expand_section_roman_numerals(text: &str) -> String {
    let mut out: Vec<String> = Vec::new();
    let mut previous_is_section = false;

    for word in text.split(' ') {
        let (lead, core, trail) = split_word_affixes(word);
        let is_section = core.starts_with(|ch: char| ch.is_ascii_uppercase())
            && SECTION_WORDS.contains(&core.to_ascii_lowercase().as_str());

        if previous_is_section {
            if let Some(value) = roman_to_u16(core) {
                out.push(format!("{lead}{value}{trail}"));
                // A numeral is never itself a section keyword for the next word.
                previous_is_section = false;
                continue;
            }
        }

        out.push(word.to_string());
        previous_is_section = is_section;
    }

    out.join(" ")
}

/// Split a whitespace-delimited word into leading punctuation, an alphanumeric
/// core, and trailing punctuation so `(VII),` keeps its wrappers while only the
/// core is tested as a numeral. An all-punctuation word yields an empty core.
fn split_word_affixes(word: &str) -> (&str, &str, &str) {
    let start = word
        .find(|ch: char| ch.is_ascii_alphanumeric())
        .unwrap_or(word.len());
    let end = word
        .rfind(|ch: char| ch.is_ascii_alphanumeric())
        .map(|index| index + 1)
        .unwrap_or(start);
    (&word[..start], &word[start..end], &word[end..])
}

/// Parse an uppercase roman numeral token into its value using the standard
/// right-to-left subtractive scan. Returns `None` for an empty token, any
/// non-roman or lowercase character, or a zero result, so only deliberate
/// uppercase numerals (`I`, `IV`, `Xii` is rejected) are ever expanded.
fn roman_to_u16(token: &str) -> Option<u16> {
    if token.is_empty() {
        return None;
    }
    let mut total: u16 = 0;
    let mut highest: u16 = 0;
    for ch in token.chars().rev() {
        let value = match ch {
            'I' => 1,
            'V' => 5,
            'X' => 10,
            'L' => 50,
            'C' => 100,
            'D' => 500,
            'M' => 1000,
            _ => return None,
        };
        if value < highest {
            total = total.checked_sub(value)?;
        } else {
            total = total.checked_add(value)?;
            highest = value;
        }
    }
    (total > 0).then_some(total)
}

/// Repair a decimal fraction the segment chunker may have split and rejoined with
/// a spurious space (`3.14` -> `3. 14`) by collapsing `digit. digit` back to
/// `digit.digit`. Only fires between two digits, so sentence-ending periods like
/// `... ends. 4 remain` are untouched.
fn collapse_decimal_dots(text: &str) -> String {
    let chars: Vec<char> = text.chars().collect();
    let mut out = String::with_capacity(text.len());
    let mut index = 0;

    while index < chars.len() {
        if chars[index].is_ascii_digit()
            && chars.get(index + 1) == Some(&'.')
            && chars.get(index + 2) == Some(&' ')
            && chars.get(index + 3).is_some_and(|ch| ch.is_ascii_digit())
        {
            out.push(chars[index]);
            out.push('.');
            // Skip the dot and the spurious space; the trailing digit is emitted
            // by the next iteration.
            index += 3;
            continue;
        }
        out.push(chars[index]);
        index += 1;
    }

    out
}

/// Convert clause-level semicolons and colons to commas so Kokoro produces a
/// medium pause (a bare `;`/`:` is often dropped or under-paused). A colon or
/// semicolon flanked by digits on both sides is left alone to preserve clock
/// times and ratios (`3:30`, `2:1`).
fn soften_clause_punctuation(text: &str) -> String {
    let chars: Vec<char> = text.chars().collect();
    let mut out = String::with_capacity(text.len());

    for (index, &ch) in chars.iter().enumerate() {
        if ch == ';' || ch == ':' {
            let previous_is_digit = index
                .checked_sub(1)
                .and_then(|prev| chars.get(prev))
                .is_some_and(|ch| ch.is_ascii_digit());
            let next_is_digit = chars
                .get(index + 1)
                .is_some_and(|ch| ch.is_ascii_digit());
            if !(previous_is_digit && next_is_digit) {
                out.push(',');
                continue;
            }
        }
        out.push(ch);
    }

    out
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
    fn roman_numerals_expand_only_after_section_words() {
        assert_eq!(
            expand_section_roman_numerals("Chapter IV begins"),
            "Chapter 4 begins"
        );
        assert_eq!(
            expand_section_roman_numerals("See Part VII."),
            "See Part 7."
        );
        assert_eq!(
            expand_section_roman_numerals("Act III, Scene II:"),
            "Act 3, Scene 2:"
        );
        // Wrapping punctuation is preserved around the expanded numeral.
        assert_eq!(
            expand_section_roman_numerals("Book (XII),"),
            "Book (12),"
        );
    }

    #[test]
    fn roman_numerals_leave_bare_letters_alone() {
        // No section keyword in front, so these standalone letters are untouched.
        assert_eq!(expand_section_roman_numerals("I went home"), "I went home");
        assert_eq!(expand_section_roman_numerals("grade C work"), "grade C work");
        assert_eq!(expand_section_roman_numerals("X marks it"), "X marks it");
        // Lowercase numeral tokens are never treated as numerals even after a keyword.
        assert_eq!(
            expand_section_roman_numerals("Part iv note"),
            "Part iv note"
        );
    }

    #[test]
    fn roman_numerals_require_capitalized_keyword() {
        // Common nouns (book/act/part/section) in lowercase prose are usually
        // followed by the pronoun "I", not a section numeral, so a lowercase
        // keyword must never trigger expansion.
        assert_eq!(
            expand_section_roman_numerals("the book I read last week"),
            "the book I read last week"
        );
        assert_eq!(
            expand_section_roman_numerals("they act I think"),
            "they act I think"
        );
        // A capitalized keyword is still expanded as a genuine reference.
        assert_eq!(expand_section_roman_numerals("Book I cover"), "Book 1 cover");
    }

    #[test]
    fn decimal_dots_recollapse_after_chunk_split() {
        assert_eq!(collapse_decimal_dots("It is 3. 14 today"), "It is 3.14 today");
        assert_eq!(collapse_decimal_dots("version 1. 2 ships"), "version 1.2 ships");
        // A real sentence boundary before a number is not a decimal.
        assert_eq!(
            collapse_decimal_dots("The talk ends. 4 people left."),
            "The talk ends. 4 people left."
        );
    }

    #[test]
    fn clause_punctuation_softens_to_commas() {
        assert_eq!(
            soften_clause_punctuation("First; then second"),
            "First, then second"
        );
        assert_eq!(
            soften_clause_punctuation("Note: read this"),
            "Note, read this"
        );
        // Clock times and ratios keep their colon.
        assert_eq!(
            soften_clause_punctuation("Meet at 3:30 for a 2:1 split"),
            "Meet at 3:30 for a 2:1 split"
        );
    }

    #[test]
    fn english_normalizer_composes_all_passes() {
        // Decimal repair runs before year expansion, so 1984 here stays a decimal
        // fraction rather than being read as a year.
        assert_eq!(
            normalize_english_synthesis_text("Chapter IV; built in 1984 at 3. 1984 cost"),
            "Chapter 4, built in nineteen eighty four at 3.1984 cost"
        );
    }

    #[test]
    fn only_english_models_normalize_text() {
        assert!(model_definition(DEFAULT_MODEL_ID)
            .unwrap()
            .english_text_normalization());
        assert!(!model_definition("sherpa-onnx/vits-piper-ar_JO-kareem-medium")
            .unwrap()
            .english_text_normalization());
    }
}
