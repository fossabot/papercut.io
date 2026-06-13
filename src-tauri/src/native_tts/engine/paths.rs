//! Filesystem paths, stable ids, hashing, and disk accounting.
//!
//! Pure helpers with no sherpa or Tauri-event dependencies (only `app.path()`
//! resolution). Everything that turns a logical thing — a model, an audiobook,
//! an uploaded document, a chunk — into an on-disk location lives here so the
//! higher engine modules never hand-build paths.
//!
//! Rust notes for a JS reader: `PathBuf` is an owned file path (like a `String`
//! for paths) and `&Path` is a borrowed view of one. `Result<PathBuf, String>`
//! means "a path, or an or message"; the `?` after a call bubbles an error
//! up to the caller instead of continuing.

use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use tauri::Manager;

use super::config::{CACHE_VERSION, MODEL_ID, MODEL_NAME};
use crate::native_tts::types::NativeTtsInputChunk;

/// Where the installed voice model lives permanently: `<app-data>/models/...`.
pub(super) fn installed_model_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|err| format!("Failed to resolve app data dir for offline voice model: {err}"))?;
    Ok(app_data.join("models/sherpa-onnx").join(MODEL_NAME))
}

/// Scratch directory used only while downloading/extracting the model. Prefers
/// the OS cache dir, falling back to app data if the cache dir can't resolve.
pub(super) fn model_work_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let cache_dir = app
        .path()
        .app_cache_dir()
        .or_else(|_| app.path().app_data_dir())
        .map_err(|err| {
            format!("Failed to resolve cache dir for offline voice model install: {err}")
        })?;
    Ok(cache_dir.join("model-installer").join(MODEL_NAME))
}

/// Return the model directory only if a complete model is present, otherwise an
/// error telling the user to run the one-time download. Used as the "is TTS
/// usable?" gate throughout the engine.
pub(super) fn resolve_model_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let model_dir = installed_model_dir(app)?;
    if has_required_files(&model_dir) {
        return Ok(model_dir);
    }

    Err(format!(
        "Missing sherpa-onnx Kokoro model. Open Audiobook settings and use Download voice model once before offline TTS. Checked: {}",
        model_dir.display()
    ))
}

/// True only if every file sherpa-onnx needs to load the Kokoro voice exists in
/// `dir`. Cheap existence checks, no contents read.
pub(super) fn has_required_files(dir: &Path) -> bool {
    dir.join("model.onnx").is_file()
        && dir.join("voices.bin").is_file()
        && dir.join("tokens.txt").is_file()
        && dir.join("espeak-ng-data/phontab").is_file()
        && dir.join("espeak-ng-data/en_dict").is_file()
        && dir.join("lexicon-us-en.txt").is_file()
}

/// Directory holding one saved audiobook's chunk WAVs. The audiobook id is
/// hashed so the folder name is short and filesystem-safe regardless of input.
pub(super) fn audiobook_dir(app: &tauri::AppHandle, audiobook_id: &str) -> Result<PathBuf, String> {
    let app_data = app.path().app_data_dir().map_err(|err| {
        format!("Failed to resolve app data dir for native audiobook cache: {err}")
    })?;
    Ok(app_data
        .join("audiobooks")
        .join(stable_hex_hash(audiobook_id)))
}

/// Deterministic file path for a single chunk's WAV inside an audiobook dir.
/// The name encodes order (`00001-`), a sanitized id, and a short content hash
/// so a changed chunk text maps to a different file (cache invalidation).
pub(super) fn chunk_path(dir: &Path, index: usize, chunk: &NativeTtsInputChunk) -> PathBuf {
    dir.join("chunks").join(format!(
        "{:05}-{}-{}.wav",
        index + 1,
        sanitize_path_part(&chunk.id),
        chunk_identity(chunk),
    ))
}

/// Cached single-track audio and timing metadata used by native mobile playback.
pub(super) fn playback_track_path(dir: &Path) -> PathBuf {
    dir.join("playback.wav")
}

pub(super) fn playback_metadata_path(dir: &Path) -> PathBuf {
    dir.join("playback.json")
}

/// Short (16-char) content fingerprint for a chunk: the frontend-supplied text
/// hash if present, otherwise a hash of the text itself.
fn chunk_identity(chunk: &NativeTtsInputChunk) -> String {
    chunk
        .text_hash
        .clone()
        .unwrap_or_else(|| stable_hex_hash(&chunk.text))
        .chars()
        .take(16)
        .collect()
}

/// Stable cross-process identity for ordered speakable chunks.
///
/// Canonical separators and FNV-1a hashing intentionally mirror TypeScript
/// `createChunkSourceSignature`; changing either side invalidates cache matching.
pub(super) fn chunk_source_signature(chunks: &[NativeTtsInputChunk]) -> String {
    let mut canonical = String::new();
    for chunk in chunks.iter().filter(|chunk| !chunk.text.trim().is_empty()) {
        canonical.push_str(&chunk.id);
        canonical.push(char::from(0));
        canonical.push_str(
            &chunk
                .text_hash
                .clone()
                .unwrap_or_else(|| stable_hex_hash(&chunk.text)),
        );
        canonical.push(char::from(10));
    }
    stable_hex_hash(&canonical)
}

/// Keep only chunks with non-blank text. Blank chunks have no audio to generate
/// or save, so every pipeline filters through this first.
pub(super) fn speakable_chunks(chunks: &[NativeTtsInputChunk]) -> Vec<NativeTtsInputChunk> {
    chunks
        .iter()
        .filter(|chunk| !chunk.text.trim().is_empty())
        .cloned()
        .collect()
}

/// Delete a directory and report `(did_it_exist, bytes_reclaimed)`. Counts size
/// before deleting because `remove_dir_all` only reports success, not bytes.
pub(super) fn remove_dir_and_count_bytes(path: &Path, label: &str) -> Result<(bool, u64), String> {
    if !path.exists() {
        return Ok((false, 0));
    }

    // Count first because remove_dir_all only tells us success/failure, not
    // how much space was reclaimed. The path is app-owned data, so a normal
    // recursive directory walk is appropriate here.
    let bytes = directory_size(path)?;
    fs::remove_dir_all(path).map_err(|err| {
        format!(
            "Failed to delete {label} directory {}: {err}",
            path.display()
        )
    })?;
    Ok((true, bytes))
}

/// Total size in bytes of a file or directory tree. Recurses into subdirectories
/// (calls itself for each entry), summing file lengths.
pub(super) fn directory_size(path: &Path) -> Result<u64, String> {
    let metadata = fs::symlink_metadata(path)
        .map_err(|err| format!("Failed to inspect {}: {err}", path.display()))?;
    if metadata.is_file() {
        return Ok(metadata.len());
    }
    if !metadata.is_dir() {
        return Ok(0);
    }

    let mut bytes = 0u64;
    for entry in fs::read_dir(path)
        .map_err(|err| format!("Failed to read directory {}: {err}", path.display()))?
    {
        let entry = entry.map_err(|err| {
            format!(
                "Failed to read directory entry in {}: {err}",
                path.display()
            )
        })?;
        bytes += directory_size(&entry.path())?;
    }
    Ok(bytes)
}

/// Pull the upload id back out of an imported document URL
/// (`/user-uploads/<id>.html`), validating the shape and that the id is hex.
/// Returns an error for any URL that isn't an imported upload.
pub(super) fn imported_upload_id_from_document_url(document_url: &str) -> Result<String, String> {
    let prefix = "/user-uploads/";
    let suffix = ".html";
    if !document_url.starts_with(prefix) || !document_url.ends_with(suffix) {
        return Err("Document is not an imported audiobook upload".into());
    }
    let id = &document_url[prefix.len()..document_url.len() - suffix.len()];
    if id.is_empty() || !id.chars().all(|ch| ch.is_ascii_hexdigit()) {
        return Err("Imported audiobook upload id is invalid".into());
    }
    Ok(id.to_string())
}

/// Directory where an imported document's source HTML/metadata is stored:
/// `<app-data>/user_uploads/<id>`.
pub(super) fn imported_upload_dir(
    app: &tauri::AppHandle,
    upload_id: &str,
) -> Result<PathBuf, String> {
    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|err| format!("Failed to resolve app data dir for imported audiobook: {err}"))?;
    Ok(app_data.join("user_uploads").join(upload_id))
}

/// Build the saved-audiobook cache key: a `|`-joined string of model id, cache
/// version, dtype, voice, speed, and the normalized document URL. Any change to
/// these means a different key (and therefore a separate cache).
pub(super) fn create_native_audiobook_id(
    document_url: &str,
    voice: &str,
    speed: f32,
    dtype: &str,
) -> String {
    [
        MODEL_ID.to_string(),
        CACHE_VERSION.to_string(),
        dtype.to_string(),
        voice.to_string(),
        format!("{speed:.2}"),
        normalize_native_document_url(document_url),
    ]
    .join("|")
}

/// Strip the `#fragment` and `?query` from a document URL so the same document
/// always produces the same cache key regardless of trailing anchors/params.
fn normalize_native_document_url(document_url: &str) -> String {
    document_url
        .split('#')
        .next()
        .unwrap_or(document_url)
        .split('?')
        .next()
        .unwrap_or(document_url)
        .to_string()
}

/// Convert a sample count + sample rate into seconds of audio (0 if rate is 0).
pub(super) fn audio_duration_sec(sample_len: usize, sample_rate: i32) -> f32 {
    if sample_rate > 0 {
        sample_len as f32 / sample_rate as f32
    } else {
        0.0
    }
}

/// Make a string safe to use as a single path segment: keep alphanumerics, `-`
/// and `_`; replace everything else with `_`; never return empty.
fn sanitize_path_part(value: &str) -> String {
    let cleaned = value
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' {
                ch
            } else {
                '_'
            }
        })
        .collect::<String>();
    if cleaned.is_empty() {
        "chunk".into()
    } else {
        cleaned
    }
}

/// A fresh, timestamped work directory for building one export, so concurrent or
/// repeated exports never clash: `<cache>/audiobook-exports/<name>-<ms>`.
pub(super) fn unique_export_work_dir(
    app: &tauri::AppHandle,
    title: &str,
) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_cache_dir()
        .or_else(|_| app.path().app_data_dir())
        .map_err(|err| format!("Failed to resolve an export work directory: {err}"))?;
    let basename = sanitize_export_basename(title);
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|err| format!("System clock error: {err}"))?
        .as_millis();
    Ok(dir
        .join("audiobook-exports")
        .join(format!("{basename}-{timestamp}")))
}

/// Turn a document title into a friendly export filename base: keep letters and
/// digits, collapse runs of punctuation/space into single spaces, cap length,
/// and fall back to "Audiobook" if nothing usable remains.
pub(super) fn sanitize_export_basename(value: &str) -> String {
    let mut cleaned = String::with_capacity(value.len());
    let mut previous_separator = false;

    for ch in value.chars() {
        let mapped = if ch.is_ascii_alphanumeric() {
            Some(ch)
        } else if ch == '-' || ch == '_' || ch.is_whitespace() {
            Some(if ch.is_whitespace() { ' ' } else { ch })
        } else {
            None
        };

        let Some(ch) = mapped else {
            if !previous_separator && !cleaned.is_empty() {
                cleaned.push(' ');
                previous_separator = true;
            }
            continue;
        };

        if ch == ' ' || ch == '-' || ch == '_' {
            if previous_separator || cleaned.is_empty() {
                continue;
            }
            cleaned.push(ch);
            previous_separator = true;
            continue;
        }

        cleaned.push(ch);
        previous_separator = false;
        if cleaned.len() >= 80 {
            break;
        }
    }

    let cleaned = cleaned.trim_matches([' ', '-', '_']).to_string();
    if cleaned.is_empty() {
        "Audiobook".into()
    } else {
        cleaned
    }
}

/// FNV-1a hash of a string, formatted as 16 hex chars. Fast and deterministic —
/// used for stable directory/id names, NOT for security.
pub(super) fn stable_hex_hash(value: &str) -> String {
    let mut hash = 0xcbf29ce484222325u64;
    for byte in value.as_bytes() {
        hash ^= *byte as u64;
        hash = hash.wrapping_mul(0x100000001b3);
    }
    format!("{hash:016x}")
}
