//! The sherpa-onnx Kokoro engine and single-chunk synthesis.
//!
//! Owns the loaded [`SherpaKokoroEngine`] (rebuilt when the requested thread
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
    OfflineTtsModelConfig,
};

use super::cache::wav_info;
use super::paths::{audio_duration_sec, resolve_model_dir};
use crate::native_tts::platform::resolve_thread_count;

/// A loaded sherpa-onnx Kokoro model plus the settings it was built with. Kept
/// alive in shared state and reused across syntheses; rebuilt only when the
/// requested thread count differs (see [`ensure_engine`]).
pub(crate) struct SherpaKokoroEngine {
    pub(super) tts: OfflineTts,
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
/// returned `&SherpaKokoroEngine` borrows from it for the rest of the call.
pub(super) fn ensure_engine<'a>(
    app: &tauri::AppHandle,
    guard: &'a mut Option<SherpaKokoroEngine>,
    thread_count: Option<i32>,
) -> Result<&'a SherpaKokoroEngine, String> {
    let requested_threads = resolve_thread_count(thread_count);
    // Rebuild only when there's no engine yet, or the desired thread count
    // differs from the loaded one (changing threads needs a fresh engine).
    let should_create = guard
        .as_ref()
        .map(|engine| engine.num_threads != requested_threads)
        .unwrap_or(true);

    if should_create {
        let model_dir = resolve_model_dir(app)?;
        *guard = Some(SherpaKokoroEngine {
            tts: create_engine(&model_dir, requested_threads)?,
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
    engine: &SherpaKokoroEngine,
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
    let _ = fs::remove_file(output_path);
    fs::rename(&temp_path, output_path).map_err(|err| {
        let _ = fs::remove_file(&temp_path);
        format!(
            "Failed to commit generated WAV {}: {err}",
            output_path.display()
        )
    })?;

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
    engine: &SherpaKokoroEngine,
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
        sid: voice_to_speaker_id(voice),
        ..Default::default()
    };

    let sanitized = sanitize_tts_text(text);
    if sanitized.trim().is_empty() {
        return Err("TTS chunk became empty after sanitization".into());
    }

    // The last arg is an optional progress callback; `None::<fn...>` means none.
    engine
        .tts
        .generate_with_config(&sanitized, &generation, None::<fn(&[f32], f32) -> bool>)
        .ok_or_else(|| "sherpa-onnx failed to synthesize audio".to_string())
}

/// Clean text for the English Kokoro/espeak path before tokenization: normalize
/// smart quotes/dashes/ellipses to ASCII, fold all whitespace to single spaces,
/// drop zero-width and control characters, and drop non-BMP symbols (emoji) that
/// can trip native tokenization.
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

        // The English Kokoro/espeak path is most reliable with BMP text.
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

/// Construct the sherpa-onnx Kokoro engine from the model files in `model_dir`,
/// wiring up model/voices/tokens/espeak-data paths and the optional lexicons,
/// pinned to the CPU provider and the given thread count.
fn create_engine(model_dir: &Path, thread_count: i32) -> Result<OfflineTts, String> {
    // Include whichever lexicon files are present, joined by commas.
    let lexicon = [
        model_dir.join("lexicon-us-en.txt"),
        model_dir.join("lexicon-zh.txt"),
    ]
    .iter()
    .filter(|path| path.is_file())
    .map(|path| path.display().to_string())
    .collect::<Vec<_>>()
    .join(",");

    // `..Default::default()` fills every field we don't set with its default —
    // like spreading defaults under an object literal.
    let config = OfflineTtsConfig {
        model: OfflineTtsModelConfig {
            kokoro: OfflineTtsKokoroModelConfig {
                model: Some(model_dir.join("model.onnx").display().to_string()),
                voices: Some(model_dir.join("voices.bin").display().to_string()),
                tokens: Some(model_dir.join("tokens.txt").display().to_string()),
                data_dir: Some(model_dir.join("espeak-ng-data").display().to_string()),
                lexicon: if lexicon.is_empty() {
                    None
                } else {
                    Some(lexicon)
                },
                lang: Some("en-us".into()),
                ..Default::default()
            },
            num_threads: thread_count,
            provider: Some("cpu".into()),
            ..Default::default()
        },
        max_num_sentences: 1,
        ..Default::default()
    };

    OfflineTts::create(&config).ok_or_else(|| "Failed to create sherpa-onnx Kokoro engine".into())
}

/// Map a Kokoro voice name to its numeric speaker id in the multi-lang model.
/// Unknown voices fall back to id 3 (`af_heart`). `match` here is an exhaustive
/// switch over the known voice strings.
fn voice_to_speaker_id(voice: &str) -> i32 {
    match voice {
        "af_alloy" => 0,
        "af_aoede" => 1,
        "af_bella" => 2,
        "af_heart" => 3,
        "af_jessica" => 4,
        "af_kore" => 5,
        "af_nicole" => 6,
        "af_nova" => 7,
        "af_river" => 8,
        "af_sarah" => 9,
        "af_sky" => 10,
        "am_echo" => 12,
        "am_eric" => 13,
        "am_fenrir" => 14,
        "am_liam" => 15,
        "am_michael" => 16,
        "am_onyx" => 17,
        "am_puck" => 18,
        "am_santa" => 19,
        "bf_alice" => 20,
        "bf_emma" => 21,
        "bf_isabella" => 22,
        "bf_lily" => 23,
        "bm_daniel" => 24,
        "bm_fable" => 25,
        "bm_george" => 26,
        "bm_lewis" => 27,
        _ => 3,
    }
}
