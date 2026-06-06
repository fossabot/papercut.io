//! Native saved-audiobook cache: scanning chunk WAVs and parsing WAV headers.
//!
//! Read playback and the save job both ask "which chunks already exist on disk,
//! and how long/large are they?" This module answers that by scanning the
//! per-audiobook chunk directory and parsing minimal RIFF/WAVE metadata without
//! decoding audio. [`WavMetadata`] additionally exposes the `data` chunk extent
//! so the export path can concatenate chunk payloads into a single track.

use std::fs;
use std::path::Path;

use base64::{engine::general_purpose, Engine as _};

use super::paths::{audiobook_dir, chunk_path, speakable_chunks};
use crate::native_tts::types::{
    NativeAudiobookChunkRequest, NativeAudiobookStatusRequest, NativeAudiobookStatusResponse,
    NativeTtsChunkResponse, NativeTtsInputChunk,
};

/// Running totals from scanning an audiobook directory. `#[derive(Default)]`
/// gives a zeroed starting value via `AudiobookScan::default()`.
#[derive(Default)]
pub(super) struct AudiobookScan {
    pub(super) cached_chunks: usize,
    pub(super) audio_duration_sec: f32,
    pub(super) wav_bytes: usize,
}

/// The cheap facts about one WAV file: how long it plays and its total size.
pub(super) struct WavInfo {
    pub(super) audio_duration_sec: f32,
    pub(super) wav_bytes: usize,
}

/// Full WAV header details needed to splice files together: the raw `fmt ` block
/// plus where the `data` samples start and how many bytes they span.
pub(super) struct WavMetadata {
    pub(super) fmt_payload: Vec<u8>,
    pub(super) precise_audio_duration_sec: f64,
    pub(super) data_offset: usize,
    pub(super) data_bytes: usize,
    pub(super) info: WavInfo,
}

/// Report how many of a document's chunks are already saved (for the UI's
/// "Saved" state and progress). Does not modify anything.
pub(crate) fn native_audiobook_status(
    app: tauri::AppHandle,
    request: NativeAudiobookStatusRequest,
) -> Result<NativeAudiobookStatusResponse, String> {
    let chunks = speakable_chunks(&request.chunks);
    let dir = audiobook_dir(&app, &request.audiobook_id)?;
    let scan = scan_audiobook(&dir, &chunks, false);

    Ok(NativeAudiobookStatusResponse {
        cached_chunks: scan.cached_chunks,
        total_chunks: chunks.len(),
        complete: !chunks.is_empty() && scan.cached_chunks == chunks.len(),
        dir: dir.display().to_string(),
        audio_duration_sec: scan.audio_duration_sec,
        wav_bytes: scan.wav_bytes,
    })
}

/// Read one already-saved chunk WAV off disk and return it base64-encoded for
/// the WebView to play. (sample_rate/duration are left 0 here; playback reads
/// them from the WAV itself.)
pub(crate) fn get_native_audiobook_chunk(
    app: tauri::AppHandle,
    request: NativeAudiobookChunkRequest,
) -> Result<NativeTtsChunkResponse, String> {
    let dir = audiobook_dir(&app, &request.audiobook_id)?;
    let path = chunk_path(&dir, request.index, &request.chunk);
    let wav = fs::read(&path).map_err(|err| {
        format!(
            "Failed to read native audiobook chunk {}: {err}",
            path.display()
        )
    })?;
    let wav_bytes = wav.len();
    Ok(NativeTtsChunkResponse {
        chunk_id: Some(request.chunk.id),
        wav_base64: general_purpose::STANDARD.encode(wav),
        sample_rate: 0,
        audio_duration_sec: 0.0,
        wav_bytes,
        generate_ms: 0,
        backend: format!("native-audiobook-cache:{}", dir.display()),
    })
}

/// Walk the expected chunk paths and tally which valid WAVs exist, plus their
/// total duration/size. With `prune_invalid` set, any present-but-unparseable
/// WAV is deleted so the save job will regenerate it.
pub(super) fn scan_audiobook(
    dir: &Path,
    chunks: &[NativeTtsInputChunk],
    prune_invalid: bool,
) -> AudiobookScan {
    let mut scan = AudiobookScan::default();
    for (index, chunk) in chunks.iter().enumerate() {
        let path = chunk_path(dir, index, chunk);
        // `let Some(..) = .. else { continue }` handles the "no valid WAV" case
        // and moves on; otherwise `info` is the parsed metadata.
        let Some(info) = wav_info(&path) else {
            if prune_invalid && path.exists() {
                let _ = fs::remove_file(path);
            }
            continue;
        };
        scan.cached_chunks += 1;
        scan.audio_duration_sec += info.audio_duration_sec;
        scan.wav_bytes += info.wav_bytes;
    }
    scan
}

/// Convenience wrapper: parse a WAV and keep only the cheap `WavInfo`. Returns
/// `None` (not an error) if the file is missing or not a valid WAV.
pub(super) fn wav_info(path: &Path) -> Option<WavInfo> {
    wav_metadata(path).map(|metadata| metadata.info)
}

/// Parse just enough of a RIFF/WAVE file to locate its `fmt ` and `data`
/// chunks and compute duration. Returns `None` on anything malformed.
///
/// WAV layout: `RIFF<size>WAVE`, then a sequence of `<id><size><payload>`
/// chunks. We walk them, capture the `fmt ` block (channels/sample rate/bit
/// depth) and the `data` extent, then derive seconds from byte counts.
pub(super) fn wav_metadata(path: &Path) -> Option<WavMetadata> {
    let bytes = fs::read(path).ok()?;
    // Minimum valid header is 44 bytes and must start with the RIFF/WAVE tags.
    if bytes.len() < 44 || &bytes[0..4] != b"RIFF" || &bytes[8..12] != b"WAVE" {
        return None;
    }

    let mut offset = 12usize; // skip "RIFF<size>WAVE"
    let mut fmt_payload = Vec::new();
    let mut channels = 0u16;
    let mut sample_rate = 0u32;
    let mut bits_per_sample = 0u16;
    let mut audio_offset = 0usize;
    let mut data_bytes = 0usize;

    // Walk each chunk: 4-byte id, 4-byte little-endian size, then payload.
    while offset + 8 <= bytes.len() {
        let id = &bytes[offset..offset + 4];
        let size = u32::from_le_bytes(bytes[offset + 4..offset + 8].try_into().ok()?) as usize;
        let payload_offset = offset + 8;
        if payload_offset + size > bytes.len() {
            return None;
        }

        if id == b"fmt " && size >= 16 {
            // Pull channel count, sample rate, and bit depth from fixed offsets
            // within the fmt payload.
            fmt_payload = bytes[payload_offset..payload_offset + size].to_vec();
            channels = u16::from_le_bytes(
                bytes[payload_offset + 2..payload_offset + 4]
                    .try_into()
                    .ok()?,
            );
            sample_rate = u32::from_le_bytes(
                bytes[payload_offset + 4..payload_offset + 8]
                    .try_into()
                    .ok()?,
            );
            bits_per_sample = u16::from_le_bytes(
                bytes[payload_offset + 14..payload_offset + 16]
                    .try_into()
                    .ok()?,
            );
        } else if id == b"data" {
            audio_offset = payload_offset;
            data_bytes = size;
            break;
        }

        // Advance to the next chunk; chunks are padded to even length.
        offset = payload_offset + size + (size % 2);
    }

    // Reject if any required field never got filled in.
    if fmt_payload.is_empty()
        || channels == 0
        || sample_rate == 0
        || bits_per_sample == 0
        || audio_offset == 0
        || data_bytes == 0
    {
        return None;
    }
    // duration = data bytes / (rate * channels * bytes-per-sample).
    let bytes_per_sample = (bits_per_sample as f64 / 8.0).max(1.0);
    let precise_audio_duration_sec =
        data_bytes as f64 / (sample_rate as f64 * channels as f64 * bytes_per_sample);
    let audio_duration_sec = precise_audio_duration_sec as f32;
    Some(WavMetadata {
        fmt_payload,
        precise_audio_duration_sec,
        data_offset: audio_offset,
        data_bytes,
        info: WavInfo {
            audio_duration_sec,
            wav_bytes: bytes.len(),
        },
    })
}
