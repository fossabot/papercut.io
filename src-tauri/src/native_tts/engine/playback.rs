//! Cached single-track preparation for native Android/iOS background playback.

use std::fs;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use super::bundle::stitch_audiobook_wav;
use super::paths::{
    audiobook_dir, playback_metadata_path, playback_track_path, speakable_chunks, stable_hex_hash,
};
use crate::native_tts::types::{
    NativeAudiobookPlaybackChunk, NativeAudiobookPlaybackRequest, NativeAudiobookPlaybackResponse,
    NativeTtsInputChunk,
};

const PLAYBACK_METADATA_VERSION: u32 = 1;

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct PlaybackMetadata {
    version: u32,
    source_signature: String,
    audio_duration_sec: f64,
    wav_bytes: usize,
    chunks: Vec<NativeAudiobookPlaybackChunk>,
}

pub(crate) fn prepare_native_audiobook_playback(
    app: tauri::AppHandle,
    request: NativeAudiobookPlaybackRequest,
) -> Result<NativeAudiobookPlaybackResponse, String> {
    let chunks = speakable_chunks(&request.chunks);
    if chunks.is_empty() {
        return Err("No speakable audiobook chunks to play".into());
    }

    let dir = audiobook_dir(&app, &request.audiobook_id)?;
    let track_path = playback_track_path(&dir);
    let metadata_path = playback_metadata_path(&dir);
    let source_signature = playback_signature(&chunks)?;

    let metadata = read_cached_metadata(&track_path, &metadata_path, &source_signature)
        .unwrap_or_else(|| {
            build_playback_track(
                &dir,
                &chunks,
                &track_path,
                &metadata_path,
                &source_signature,
            )
        })?;
    let audio_url = tauri::Url::from_file_path(&track_path)
        .map_err(|_| {
            format!(
                "Failed to convert playback path to a file URL: {}",
                track_path.display()
            )
        })?
        .to_string();

    Ok(NativeAudiobookPlaybackResponse {
        audio_url,
        audio_duration_sec: metadata.audio_duration_sec,
        wav_bytes: metadata.wav_bytes,
        chunks: metadata.chunks,
    })
}

fn read_cached_metadata(
    track_path: &Path,
    metadata_path: &Path,
    source_signature: &str,
) -> Option<Result<PlaybackMetadata, String>> {
    if !track_path.is_file() || !metadata_path.is_file() {
        return None;
    }

    let bytes = fs::read(metadata_path).ok()?;
    let metadata = serde_json::from_slice::<PlaybackMetadata>(&bytes).ok()?;
    let track_bytes = fs::metadata(track_path).ok()?.len() as usize;
    if metadata.version != PLAYBACK_METADATA_VERSION
        || metadata.source_signature != source_signature
        || metadata.wav_bytes != track_bytes
        || metadata.chunks.is_empty()
    {
        return None;
    }
    Some(Ok(metadata))
}

fn build_playback_track(
    dir: &Path,
    chunks: &[NativeTtsInputChunk],
    track_path: &Path,
    metadata_path: &Path,
    source_signature: &str,
) -> Result<PlaybackMetadata, String> {
    let summary = stitch_audiobook_wav(dir, chunks, track_path)?;
    let metadata = PlaybackMetadata {
        version: PLAYBACK_METADATA_VERSION,
        source_signature: source_signature.to_string(),
        audio_duration_sec: summary.audio_duration_sec as f64,
        wav_bytes: summary.wav_bytes,
        chunks: summary.chunk_timings,
    };
    write_metadata_atomically(metadata_path, &metadata)?;
    Ok(metadata)
}

fn playback_signature(chunks: &[NativeTtsInputChunk]) -> Result<String, String> {
    let serialized = serde_json::to_string(chunks)
        .map_err(|err| format!("Failed to fingerprint audiobook chunks: {err}"))?;
    Ok(stable_hex_hash(&serialized))
}

fn write_metadata_atomically(path: &Path, metadata: &PlaybackMetadata) -> Result<(), String> {
    let bytes = serde_json::to_vec_pretty(metadata)
        .map_err(|err| format!("Failed to serialize playback metadata: {err}"))?;
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|err| format!("System clock error: {err}"))?
        .as_nanos();
    let temp_path = path.with_extension(format!("json.{nonce}.tmp"));
    fs::write(&temp_path, bytes).map_err(|err| {
        format!(
            "Failed to write playback metadata {}: {err}",
            temp_path.display()
        )
    })?;
    let _ = fs::remove_file(path);
    fs::rename(&temp_path, path).map_err(|err| {
        let _ = fs::remove_file(&temp_path);
        format!(
            "Failed to commit playback metadata {}: {err}",
            path.display()
        )
    })
}
