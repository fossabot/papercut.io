//! Export a saved audiobook to a single `.papercut-audiobook` bundle file.
//!
//! Flow: stitch the per-chunk WAVs into one combined WAV, write a JSON metadata
//! sidecar and the original source HTML, then pack the metadata + HTML + every
//! chunk WAV + the combined WAV behind the bundle header.
//!
//! Rust notes for a JS reader: `Result<T, String>` is this codebase's "either a
//! value or an error message" type — the trailing `?` after a call means "if it
//! was an error, return that error now" (like rethrowing). A `&` in front of a
//! type (`&Path`) is a borrowed reference: the function reads the value without
//! taking ownership, similar to passing an object you promise not to keep.

use std::fs;
use std::io::{BufWriter, Read, Write};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::json;
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_fs::{FilePath, FsExt, OpenOptions};

use super::super::cache::{wav_metadata, WavMetadata};
use super::super::config::{BUNDLE_MAGIC, CACHE_VERSION, MODEL_ID};
use super::super::paths::{
    audiobook_dir, chunk_path, sanitize_export_basename, speakable_chunks, unique_export_work_dir,
};
use crate::native_tts::types::{
    NativeAudiobookExportRequest, NativeAudiobookExportResponse, NativeAudiobookPlaybackChunk,
    NativeTtsInputChunk,
};

/// Totals describing the single stitched WAV, threaded back up to the response.
pub(crate) struct WavExportSummary {
    pub(crate) chunks: usize,
    pub(crate) audio_duration_sec: f32,
    pub(crate) wav_bytes: usize,
    pub(crate) chunk_timings: Vec<NativeAudiobookPlaybackChunk>,
}

/// Top-level export entry point.
///
/// Asks the OS for a save location, builds the combined WAV + sidecars in a
/// temporary work directory, writes the final bundle to the chosen path, then
/// cleans up the work directory. Returns metadata about what was written.
pub(crate) fn export_audiobook_native(
    app: tauri::AppHandle,
    request: NativeAudiobookExportRequest,
) -> Result<NativeAudiobookExportResponse, String> {
    // Drop blank chunks up front; an export with nothing to say is an error.
    let chunks = speakable_chunks(&request.chunks);
    if chunks.is_empty() {
        return Err("No speakable audiobook chunks to export".into());
    }

    // Open the native "Save As" dialog. `blocking_save_file` returns None if the
    // user cancels, which `ok_or_else` turns into an error.
    let basename = sanitize_export_basename(&request.title);
    let destination = app
        .dialog()
        .file()
        .set_title("Export Audiobook Bundle")
        .set_file_name(format!("{basename}.papercut-audiobook"))
        .add_filter("Papercut Audiobook", &["papercut-audiobook"])
        .blocking_save_file()
        .ok_or_else(|| "Audiobook export cancelled".to_string())?;
    let destination_label = destination.to_string();

    // Build artifacts in a throwaway work dir so a failure never leaves a
    // half-written file at the user's chosen path.
    let dir = audiobook_dir(&app, &request.audiobook_id)?;
    let export_dir = unique_export_work_dir(&app, &request.title)?;
    fs::create_dir_all(&export_dir).map_err(|err| {
        format!(
            "Failed to create audiobook export work directory {}: {err}",
            export_dir.display()
        )
    })?;

    let audio_filename = format!("{basename}.wav");
    let audio_path = export_dir.join(&audio_filename);
    let metadata_path = export_dir.join("metadata.json");
    let html_path = export_dir.join("source.html");
    let export = stitch_audiobook_wav(&dir, &chunks, &audio_path)?;
    write_export_sidecars(
        &request,
        &chunks,
        &export,
        &audio_path,
        &metadata_path,
        &html_path,
    )?;
    write_export_bundle(
        &app,
        destination,
        &request,
        &chunks,
        &export,
        &audio_path,
        &metadata_path,
        &html_path,
        &audio_filename,
    )?;
    let _ = fs::remove_dir_all(&export_dir);

    Ok(NativeAudiobookExportResponse {
        path: destination_label,
        audio_path: audio_filename,
        metadata_path: "metadata.json".into(),
        html_path: "source.html".into(),
        chunks: export.chunks,
        audio_duration_sec: export.audio_duration_sec,
        wav_bytes: export.wav_bytes,
    })
}

/// Concatenate every saved chunk WAV into one valid WAV file at `output_path`.
///
/// WAV files are `RIFF` containers: a header, a `fmt ` chunk describing the
/// audio format, and a `data` chunk holding raw samples. To merge N files we
/// reuse the first file's `fmt ` block, then write one big `data` chunk that is
/// every input's samples back-to-back. We require all inputs to share the same
/// format and guard the 4 GB RIFF size limit. Writes to a temp file first, then
/// renames into place (an atomic "all or nothing" swap).
pub(crate) fn stitch_audiobook_wav(
    dir: &Path,
    chunks: &[NativeTtsInputChunk],
    output_path: &Path,
) -> Result<WavExportSummary, String> {
    // First pass: locate each chunk WAV and read just its header metadata
    // (offset + length of the `data` chunk), summing total bytes/duration.
    let mut metas: Vec<(PathBuf, WavMetadata)> = Vec::with_capacity(chunks.len());
    let mut total_data_bytes = 0u64;
    let mut total_audio_duration_sec = 0f64;
    let mut chunk_timings = Vec::with_capacity(chunks.len());

    for (index, chunk) in chunks.iter().enumerate() {
        let path = chunk_path(dir, index, chunk);
        let metadata = wav_metadata(&path).ok_or_else(|| {
            format!(
                "Missing or invalid saved audiobook chunk {}/{}: {}",
                index + 1,
                chunks.len(),
                path.display()
            )
        })?;

        // Every chunk must share the first chunk's audio format, otherwise the
        // concatenated samples would be garbage.
        if let Some((_, first)) = metas.first() {
            if metadata.fmt_payload != first.fmt_payload {
                return Err(format!(
                    "Saved audiobook chunk {} has a different WAV format",
                    index + 1
                ));
            }
        }

        let duration_sec = metadata.precise_audio_duration_sec;
        chunk_timings.push(NativeAudiobookPlaybackChunk {
            index,
            chunk_id: chunk.id.clone(),
            start_sec: total_audio_duration_sec,
            duration_sec,
        });
        total_data_bytes += metadata.data_bytes as u64;
        total_audio_duration_sec += duration_sec;
        metas.push((path, metadata));
    }

    // RIFF stores sizes as unsigned 32-bit, so the combined audio cannot exceed
    // ~4 GB. Bail before writing anything if it would.
    if total_data_bytes > u32::MAX as u64 {
        return Err("Exported WAV would exceed the 4 GB RIFF/WAV limit".into());
    }

    if let Some(parent) = output_path.parent() {
        fs::create_dir_all(parent).map_err(|err| {
            format!(
                "Failed to create export directory {}: {err}",
                parent.display()
            )
        })?;
    }

    // Write to "<output>.<nanos>.tmp" first. BufWriter batches small writes into
    // larger OS writes (like buffering output instead of many syscalls).
    let temp_path = output_path.with_extension(format!(
        "wav.{}.tmp",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|err| format!("System clock error: {err}"))?
            .as_nanos()
    ));
    let file = fs::File::create(&temp_path).map_err(|err| {
        format!(
            "Failed to create audiobook export {}: {err}",
            temp_path.display()
        )
    })?;
    let mut writer = BufWriter::new(file);

    // RIFF/WAVE chunks are 2-byte aligned, so odd-length sections get one pad
    // byte. Compute the overall RIFF size (everything after "RIFF<size>").
    let fmt_payload = &metas[0].1.fmt_payload;
    let fmt_padding = fmt_payload.len() % 2;
    let data_padding = total_data_bytes as usize % 2;
    let riff_size = 4u64
        + 8
        + fmt_payload.len() as u64
        + fmt_padding as u64
        + 8
        + total_data_bytes
        + data_padding as u64;
    if riff_size > u32::MAX as u64 {
        let _ = fs::remove_file(&temp_path);
        return Err("Exported WAV would exceed the 4 GB RIFF/WAV limit".into());
    }

    // Header: "RIFF" + total size + "WAVE", then the shared "fmt " chunk.
    // `to_le_bytes` writes the integer in little-endian byte order, as WAV
    // requires. `map_err(write_export_err)` converts an I/O error into a String.
    writer.write_all(b"RIFF").map_err(write_export_err)?;
    writer
        .write_all(&(riff_size as u32).to_le_bytes())
        .map_err(write_export_err)?;
    writer.write_all(b"WAVE").map_err(write_export_err)?;
    writer.write_all(b"fmt ").map_err(write_export_err)?;
    writer
        .write_all(&(fmt_payload.len() as u32).to_le_bytes())
        .map_err(write_export_err)?;
    writer.write_all(fmt_payload).map_err(write_export_err)?;
    if fmt_padding > 0 {
        writer.write_all(&[0]).map_err(write_export_err)?;
    }

    // One "data" chunk header for the combined samples...
    writer.write_all(b"data").map_err(write_export_err)?;
    writer
        .write_all(&(total_data_bytes as u32).to_le_bytes())
        .map_err(write_export_err)?;

    // ...then each input's raw samples (the slice between data_offset and
    // data_offset + data_bytes) appended in order.
    for (path, metadata) in &metas {
        let bytes = fs::read(path)
            .map_err(|err| format!("Failed to read audiobook chunk {}: {err}", path.display()))?;
        writer
            .write_all(&bytes[metadata.data_offset..metadata.data_offset + metadata.data_bytes])
            .map_err(write_export_err)?;
    }
    if data_padding > 0 {
        writer.write_all(&[0]).map_err(write_export_err)?;
    }
    writer.flush().map_err(write_export_err)?;
    drop(writer); // Close the file (drop runs its cleanup) before renaming it.

    // Atomically move the finished temp file onto the real path.
    let _ = fs::remove_file(output_path);
    fs::rename(&temp_path, output_path).map_err(|err| {
        let _ = fs::remove_file(&temp_path);
        format!(
            "Failed to commit audiobook export {}: {err}",
            output_path.display()
        )
    })?;

    let wav_bytes = fs::metadata(output_path)
        .map_err(|err| format!("Failed to inspect audiobook export: {err}"))?
        .len() as usize;

    Ok(WavExportSummary {
        chunks: chunks.len(),
        audio_duration_sec: total_audio_duration_sec as f32,
        wav_bytes,
        chunk_timings,
    })
}

/// Write the two human/portable sidecar files next to the combined WAV: the
/// original `source.html` and a `metadata.json` describing the export (voice,
/// speed, model id, chunk list, etc.). These are also packed into the bundle.
fn write_export_sidecars(
    request: &NativeAudiobookExportRequest,
    chunks: &[NativeTtsInputChunk],
    export: &WavExportSummary,
    audio_path: &Path,
    metadata_path: &Path,
    html_path: &Path,
) -> Result<(), String> {
    fs::write(html_path, request.source_html.as_bytes())
        .map_err(|err| format!("Failed to write source HTML {}: {err}", html_path.display()))?;

    let exported_at_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|err| format!("System clock error: {err}"))?
        .as_millis();
    let audio_file = audio_path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("audiobook.wav");
    // `json!` builds a JSON value inline, much like writing an object literal.
    let metadata = json!({
        "version": 1,
        "kind": "papercut-audiobook-export",
        "documentUrl": request.document_url,
        "title": request.title,
        "voice": request.voice,
        "speed": request.speed,
        "dtype": request.dtype,
        "modelId": MODEL_ID,
        "cacheVersion": CACHE_VERSION,
        "audiobookId": request.audiobook_id,
        "exportedAtMs": exported_at_ms,
        "files": {
            "audio": audio_file,
            "sourceHtml": "source.html"
        },
        "audio": {
            "format": "wav",
            "singleTrack": true,
            "durationSec": export.audio_duration_sec,
            "bytes": export.wav_bytes
        },
        "chunks": chunks,
    });
    let json = serde_json::to_vec_pretty(&metadata)
        .map_err(|err| format!("Failed to serialize audiobook export metadata: {err}"))?;
    fs::write(metadata_path, json).map_err(|err| {
        format!(
            "Failed to write audiobook export metadata {}: {err}",
            metadata_path.display()
        )
    })
}

/// Pack everything into the final `.papercut-audiobook` file at `destination`.
///
/// Builds the manifest entry list first (computing each payload's running byte
/// offset), serializes the manifest to JSON, then writes:
/// magic bytes → manifest length → manifest JSON → each payload in order.
/// Payload order here must match the offsets recorded in the manifest.
#[allow(clippy::too_many_arguments)]
fn write_export_bundle(
    app: &tauri::AppHandle,
    destination: FilePath,
    request: &NativeAudiobookExportRequest,
    chunks: &[NativeTtsInputChunk],
    export: &WavExportSummary,
    audio_path: &Path,
    metadata_path: &Path,
    html_path: &Path,
    audio_filename: &str,
) -> Result<(), String> {
    let dir = audiobook_dir(app, &request.audiobook_id)?;
    let metadata_bytes = fs::metadata(metadata_path)
        .map_err(|err| format!("Failed to inspect export metadata: {err}"))?
        .len();
    let html_bytes = fs::metadata(html_path)
        .map_err(|err| format!("Failed to inspect export HTML: {err}"))?
        .len();
    let exported_at_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|err| format!("System clock error: {err}"))?
        .as_millis();

    // Describe each packed file. `push_bundle_entry` advances `payload_offset`
    // by the entry size so offsets line up with the payload write order below.
    let mut payload_offset = 0u64;
    let mut manifest_entries = Vec::with_capacity(chunks.len() + 3);
    push_bundle_entry(
        &mut manifest_entries,
        "metadata.json",
        "metadata",
        "application/json",
        metadata_bytes,
        &mut payload_offset,
        None,
    );
    push_bundle_entry(
        &mut manifest_entries,
        "source.html",
        "sourceHtml",
        "text/html; charset=utf-8",
        html_bytes,
        &mut payload_offset,
        None,
    );

    for (index, chunk) in chunks.iter().enumerate() {
        if chunk.text.trim().is_empty() {
            continue;
        }
        let path = chunk_path(&dir, index, chunk);
        let bytes = fs::metadata(&path)
            .map_err(|err| {
                format!(
                    "Failed to inspect saved audiobook chunk {}: {err}",
                    path.display()
                )
            })?
            .len();
        push_bundle_entry(
            &mut manifest_entries,
            &format!("chunks/{:05}.wav", index + 1),
            "chunkWav",
            "audio/wav",
            bytes,
            &mut payload_offset,
            Some(index),
        );
    }

    push_bundle_entry(
        &mut manifest_entries,
        &format!("audio/{audio_filename}"),
        "singleTrackWav",
        "audio/wav",
        export.wav_bytes as u64,
        &mut payload_offset,
        None,
    );

    let manifest = json!({
        "version": 2,
        "kind": "papercut-audiobook-bundle",
        "sourceDocumentUrl": request.document_url,
        "title": request.title,
        "voice": request.voice,
        "speed": request.speed,
        "dtype": request.dtype,
        "modelId": MODEL_ID,
        "cacheVersion": CACHE_VERSION,
        "exportedAtMs": exported_at_ms,
        "files": manifest_entries,
        "audio": {
            "format": "wav",
            "singleTrack": true,
            "durationSec": export.audio_duration_sec,
            "bytes": export.wav_bytes,
        },
        "chunks": chunks,
    });
    let manifest_json = serde_json::to_vec_pretty(&manifest)
        .map_err(|err| format!("Failed to serialize audiobook bundle manifest: {err}"))?;

    // The destination came from the dialog plugin, so open it through the fs
    // plugin (which understands those handles) rather than std::fs.
    let mut options = OpenOptions::new();
    options.write(true).create(true).truncate(true);
    let file = app
        .fs()
        .open(destination, options)
        .map_err(|err| format!("Failed to open the selected audiobook export file: {err}"))?;
    let mut writer = BufWriter::new(file);
    // Header: magic + manifest length (u64, little-endian) + manifest JSON.
    writer.write_all(BUNDLE_MAGIC).map_err(write_export_err)?;
    writer
        .write_all(&(manifest_json.len() as u64).to_le_bytes())
        .map_err(write_export_err)?;
    writer.write_all(&manifest_json).map_err(write_export_err)?;
    // Payloads, in the exact order their offsets were assigned above.
    write_file_payload(&mut writer, metadata_path)?;
    write_file_payload(&mut writer, html_path)?;
    for (index, chunk) in chunks.iter().enumerate() {
        if chunk.text.trim().is_empty() {
            continue;
        }
        write_file_payload(&mut writer, &chunk_path(&dir, index, chunk))?;
    }
    write_file_payload(&mut writer, audio_path)?;
    writer.flush().map_err(write_export_err)
}

/// Append one file's manifest entry and bump the running payload offset.
///
/// `entries` and `payload_offset` are `&mut` (mutable borrows) so this helper
/// edits the caller's vector and counter in place. `chunk_index` is `Option`
/// (Some(i) for chunk WAVs, None otherwise) — Rust's null-free "maybe a value".
fn push_bundle_entry(
    entries: &mut Vec<serde_json::Value>,
    path: &str,
    role: &str,
    content_type: &str,
    bytes: u64,
    payload_offset: &mut u64,
    chunk_index: Option<usize>,
) {
    entries.push(json!({
        "path": path,
        "role": role,
        "contentType": content_type,
        "bytes": bytes,
        "payloadOffset": *payload_offset,
        "chunkIndex": chunk_index,
    }));
    *payload_offset += bytes;
}

/// Stream one file's bytes into the bundle writer in 64 KB blocks.
///
/// Generic over `W: Write` so it works with any writer (here a buffered file).
/// The loop reads until `read == 0` (end of file), copying each block out.
fn write_file_payload<W: Write>(writer: &mut W, path: &Path) -> Result<(), String> {
    let file = fs::File::open(path).map_err(|err| {
        format!(
            "Failed to open audiobook bundle payload {}: {err}",
            path.display()
        )
    })?;
    let mut reader = std::io::BufReader::new(file);
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let read = reader.read(&mut buffer).map_err(|err| {
            format!(
                "Failed to read audiobook bundle payload {}: {err}",
                path.display()
            )
        })?;
        if read == 0 {
            break;
        }
        writer
            .write_all(&buffer[..read])
            .map_err(write_export_err)?;
    }
    Ok(())
}

/// Small adapter turning a low-level I/O error into our `String` error type, so
/// the many `writer.write_all(...).map_err(write_export_err)?` calls stay terse.
fn write_export_err(err: std::io::Error) -> String {
    format!("Failed to write audiobook export: {err}")
}
