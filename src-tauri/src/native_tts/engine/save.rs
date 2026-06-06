//! Long-running native audiobook save jobs.
//!
//! A single blocking job generates every missing chunk in sequence, writing WAV
//! files straight to app data and emitting per-chunk progress on
//! [`SAVE_PROGRESS_EVENT`]. Cancellation is cooperative: the command inserts the
//! job id into the shared cancelled set and the loop checks it between chunks.
//! [`write_manifest`] records the save and is reused by the bundle import path.
//!
//! Rust notes for a JS reader: `Arc<Mutex<T>>` is a thread-safe shared handle —
//! `Arc` lets multiple owners point at the same value (reference counted) and
//! `Mutex` ensures one thread mutates it at a time. `.clone()` on an `Arc`
//! copies the handle, not the data, so the save thread and the command share one
//! engine/cancellation set.

use std::collections::HashSet;
use std::fs;
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use tauri::Emitter;

use super::cache::{scan_audiobook, wav_info};
use super::config::SAVE_PROGRESS_EVENT;
use super::paths::{
    audiobook_dir, chunk_path, playback_metadata_path, playback_track_path, speakable_chunks,
};
use super::synth::{ensure_engine, synthesize_to_file, text_preview, SherpaKokoroEngine};
use crate::native_tts::platform::resolve_thread_count;
use crate::native_tts::state::NativeTtsState;
use crate::native_tts::types::{
    NativeAudiobookSaveProgress, NativeAudiobookSaveRequest, NativeAudiobookSaveResponse,
    NativeTtsInputChunk,
};

/// The `manifest.json` written next to a saved audiobook's chunks. `<'a>` is a
/// lifetime: the borrowed `&str`/slice fields point at the request's data and
/// are only valid while it lives, which is fine since we serialize immediately.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct NativeAudiobookManifest<'a> {
    version: u8,
    document_url: &'a str,
    title: &'a str,
    voice: &'a str,
    speed: f32,
    thread_count: i32,
    chunks: &'a [NativeTtsInputChunk],
    generated_at_ms: u128,
}

/// Tauri command backend: start (or resume) saving the full audiobook.
///
/// Clears any stale cancellation for this job id, then runs the actual work on a
/// blocking thread (it does heavy inference and large file writes). Shared state
/// is `.clone()`d so the spawned closure owns its own handles.
pub(crate) async fn save_audiobook_native(
    app: tauri::AppHandle,
    state: tauri::State<'_, NativeTtsState>,
    request: NativeAudiobookSaveRequest,
) -> Result<NativeAudiobookSaveResponse, String> {
    let engine = state.engine.clone();
    let cancelled_jobs = state.cancelled_jobs.clone();
    {
        let mut cancelled = cancelled_jobs
            .lock()
            .map_err(|_| "Native TTS cancellation lock poisoned".to_string())?;
        cancelled.remove(&request.job_id);
    }

    tauri::async_runtime::spawn_blocking(move || {
        save_audiobook_native_blocking(app, engine, cancelled_jobs, request)
    })
    .await
    .map_err(|err| format!("Native audiobook save task failed: {err}"))?
}

/// Tauri command backend: request cancellation of a running save by job id.
/// Just records the id in the shared set; the save loop notices between chunks.
pub(crate) fn cancel_audiobook_save(
    state: tauri::State<'_, NativeTtsState>,
    job_id: String,
) -> Result<(), String> {
    let mut cancelled = state
        .cancelled_jobs
        .lock()
        .map_err(|_| "Native TTS cancellation lock poisoned".to_string())?;
    cancelled.insert(job_id);
    Ok(())
}

/// The actual save loop, run on a blocking thread.
///
/// Scans which chunks already exist (so Resume skips them), loads the engine
/// once, then for each missing chunk: checks for cancellation, synthesizes it to
/// disk, and emits progress. On success writes the manifest and a final "saved"
/// event. Returns aggregate totals for the whole audiobook.
fn save_audiobook_native_blocking(
    app: tauri::AppHandle,
    engine_state: Arc<Mutex<Option<SherpaKokoroEngine>>>,
    cancelled_jobs: Arc<Mutex<HashSet<String>>>,
    request: NativeAudiobookSaveRequest,
) -> Result<NativeAudiobookSaveResponse, String> {
    let started = Instant::now();
    let chunks = speakable_chunks(&request.chunks);
    let total_chunks = chunks.len();
    let dir = audiobook_dir(&app, &request.audiobook_id)?;
    let chunks_dir = dir.join("chunks");
    fs::create_dir_all(&chunks_dir).map_err(|err| {
        format!(
            "Failed to create native audiobook directory {}: {err}",
            chunks_dir.display()
        )
    })?;

    // Scan with prune=true so invalid leftovers are removed and regenerated.
    let backend = "sherpa-onnx-kokoro".to_string();
    let mut scan = scan_audiobook(&dir, &chunks, true);
    let mut cached_chunks = scan.cached_chunks;
    let mut generated_chunks = 0usize;
    let mut total_generate_ms = 0u128;
    let mut generated_audio_duration_sec = 0f32;
    let mut generated_wav_bytes = 0usize;

    // Initial "checking" progress so the UI shows the cache state immediately.
    emit_progress(
        &app,
        NativeAudiobookSaveProgress {
            job_id: request.job_id.clone(),
            status: "checking".into(),
            message: "Checking native audiobook cache".into(),
            cached_chunks,
            total_chunks,
            generated_chunks,
            chunk_id: None,
            chunk_number: None,
            text_chars: None,
            text_preview: None,
            generate_ms: None,
            audio_duration_sec: None,
            wav_bytes: None,
            total_audio_duration_sec: scan.audio_duration_sec,
            total_wav_bytes: scan.wav_bytes,
            backend: backend.clone(),
        },
    );

    if total_chunks == 0 {
        return Err("No speakable audiobook chunks to save".into());
    }

    // Load the engine once for the whole job, then build a richer backend label
    // that includes the model dir and thread count for diagnostics.
    let thread_count = resolve_thread_count(request.thread_count);
    let mut guard = engine_state
        .lock()
        .map_err(|_| "Native TTS engine lock poisoned".to_string())?;
    let engine = ensure_engine(&app, &mut guard, Some(thread_count))?;
    let backend = format!(
        "sherpa-onnx-kokoro:{}:threads={}",
        engine.model_dir.display(),
        engine.num_threads
    );

    for (index, chunk) in chunks.iter().enumerate() {
        // Cooperative cancellation: bail out cleanly between chunks if asked.
        if is_cancelled(&cancelled_jobs, &request.job_id)? {
            emit_progress(
                &app,
                NativeAudiobookSaveProgress {
                    job_id: request.job_id.clone(),
                    status: "cancelled".into(),
                    message: "Audiobook save cancelled".into(),
                    cached_chunks,
                    total_chunks,
                    generated_chunks,
                    chunk_id: Some(chunk.id.clone()),
                    chunk_number: Some(index + 1),
                    text_chars: None,
                    text_preview: Some(text_preview(&chunk.text)),
                    generate_ms: None,
                    audio_duration_sec: None,
                    wav_bytes: None,
                    total_audio_duration_sec: scan.audio_duration_sec,
                    total_wav_bytes: scan.wav_bytes,
                    backend: backend.clone(),
                },
            );
            return Err("Audiobook save cancelled".into());
        }

        // Skip chunks already saved as valid WAVs (Resume); drop invalid ones.
        let output_path = chunk_path(&dir, index, chunk);
        if output_path.is_file() {
            if wav_info(&output_path).is_some() {
                continue;
            }
            let _ = fs::remove_file(&output_path);
        }

        // "Generating chunk N/total" before the (slow) synthesis call.
        emit_progress(
            &app,
            NativeAudiobookSaveProgress {
                job_id: request.job_id.clone(),
                status: "saving".into(),
                message: format!("Generating chunk {}/{}", index + 1, total_chunks),
                cached_chunks,
                total_chunks,
                generated_chunks,
                chunk_id: Some(chunk.id.clone()),
                chunk_number: Some(index + 1),
                text_chars: Some(chunk.text.chars().count()),
                text_preview: Some(text_preview(&chunk.text)),
                generate_ms: None,
                audio_duration_sec: None,
                wav_bytes: None,
                total_audio_duration_sec: scan.audio_duration_sec,
                total_wav_bytes: scan.wav_bytes,
                backend: backend.clone(),
            },
        );

        // Synthesize this chunk to its file and fold its stats into the totals.
        let result = synthesize_to_file(
            engine,
            &chunk.text,
            &request.voice,
            request.speed,
            &output_path,
        )?;
        generated_chunks += 1;
        cached_chunks += 1;
        total_generate_ms += result.generate_ms;
        generated_audio_duration_sec += result.audio_duration_sec;
        generated_wav_bytes += result.wav_bytes;
        scan.audio_duration_sec += result.audio_duration_sec;
        scan.wav_bytes += result.wav_bytes;

        // "Saved chunk N/total" with this chunk's measured timing/size.
        emit_progress(
            &app,
            NativeAudiobookSaveProgress {
                job_id: request.job_id.clone(),
                status: "saving".into(),
                message: format!("Saved chunk {}/{}", cached_chunks, total_chunks),
                cached_chunks,
                total_chunks,
                generated_chunks,
                chunk_id: Some(chunk.id.clone()),
                chunk_number: Some(index + 1),
                text_chars: Some(chunk.text.chars().count()),
                text_preview: Some(text_preview(&chunk.text)),
                generate_ms: Some(result.generate_ms),
                audio_duration_sec: Some(result.audio_duration_sec),
                wav_bytes: Some(result.wav_bytes),
                total_audio_duration_sec: scan.audio_duration_sec,
                total_wav_bytes: scan.wav_bytes,
                backend: backend.clone(),
            },
        );
    }

    // Record the manifest and clear any cancellation flag for this job.
    write_manifest(&dir, &request, &chunks, thread_count)?;
    clear_cancelled(&cancelled_jobs, &request.job_id)?;

    // Final "saved" event with whole-job totals.
    emit_progress(
        &app,
        NativeAudiobookSaveProgress {
            job_id: request.job_id.clone(),
            status: "saved".into(),
            message: "Audiobook saved".into(),
            cached_chunks: total_chunks,
            total_chunks,
            generated_chunks,
            chunk_id: None,
            chunk_number: None,
            text_chars: None,
            text_preview: None,
            generate_ms: Some(total_generate_ms),
            audio_duration_sec: Some(generated_audio_duration_sec),
            wav_bytes: Some(generated_wav_bytes),
            total_audio_duration_sec: scan.audio_duration_sec,
            total_wav_bytes: scan.wav_bytes,
            backend: backend.clone(),
        },
    );

    Ok(NativeAudiobookSaveResponse {
        job_id: request.job_id,
        cached_chunks: total_chunks,
        total_chunks,
        generated_chunks,
        complete: true,
        dir: dir.display().to_string(),
        generate_ms: started.elapsed().as_millis(),
        audio_duration_sec: scan.audio_duration_sec,
        wav_bytes: scan.wav_bytes,
        backend,
    })
}

/// Write `manifest.json` recording what was saved (document, voice, speed,
/// chunk list, timestamp). Reused by the bundle import path so imported
/// audiobooks carry the same manifest a local save would produce.
pub(super) fn write_manifest(
    dir: &Path,
    request: &NativeAudiobookSaveRequest,
    chunks: &[NativeTtsInputChunk],
    thread_count: i32,
) -> Result<(), String> {
    let _ = fs::remove_file(playback_track_path(dir));
    let _ = fs::remove_file(playback_metadata_path(dir));
    let generated_at_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|err| format!("System clock error: {err}"))?
        .as_millis();
    let manifest = NativeAudiobookManifest {
        version: 1,
        document_url: &request.document_url,
        title: &request.title,
        voice: &request.voice,
        speed: request.speed,
        thread_count,
        chunks,
        generated_at_ms,
    };
    let json = serde_json::to_vec_pretty(&manifest)
        .map_err(|err| format!("Failed to serialize native audiobook manifest: {err}"))?;
    fs::write(dir.join("manifest.json"), json)
        .map_err(|err| format!("Failed to write native audiobook manifest: {err}"))
}

/// Emit one save-progress event to the frontend. Errors are ignored on purpose
/// (a dropped progress event must never fail the save).
fn emit_progress(app: &tauri::AppHandle, progress: NativeAudiobookSaveProgress) {
    let _ = app.emit(SAVE_PROGRESS_EVENT, progress);
}

/// Has this job been asked to cancel? Reads the shared cancelled-id set.
fn is_cancelled(
    cancelled_jobs: &Arc<Mutex<HashSet<String>>>,
    job_id: &str,
) -> Result<bool, String> {
    let cancelled = cancelled_jobs
        .lock()
        .map_err(|_| "Native TTS cancellation lock poisoned".to_string())?;
    Ok(cancelled.contains(job_id))
}

/// Remove this job's id from the cancelled set once it finishes successfully.
fn clear_cancelled(
    cancelled_jobs: &Arc<Mutex<HashSet<String>>>,
    job_id: &str,
) -> Result<(), String> {
    let mut cancelled = cancelled_jobs
        .lock()
        .map_err(|_| "Native TTS cancellation lock poisoned".to_string())?;
    cancelled.remove(job_id);
    Ok(())
}
