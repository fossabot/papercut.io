//! The `#[tauri::command]` edge exposed to the frontend.
//!
//! Each command is a thin wrapper that marshals arguments and delegates to the
//! active backend. A single `#[cfg]` switch picks `engine` (real synthesis) or
//! `stub` (native TTS not compiled); both expose the same function names and
//! signatures, so the command bodies below are identical across build configs.
//! Commands that wrap a blocking backend call move that work onto the blocking
//! thread pool so the async runtime is never stalled by filesystem or native
//! inference I/O.

use super::state::NativeTtsState;
use super::types::{
    NativeAudiobookChunkRequest, NativeAudiobookDeleteRequest, NativeAudiobookDeleteResponse,
    NativeAudiobookExportRequest, NativeAudiobookExportResponse, NativeAudiobookImportResponse,
    NativeAudiobookSaveRequest, NativeAudiobookSaveResponse, NativeAudiobookStatusRequest,
    NativeAudiobookStatusResponse, NativeImportedAudiobookSourceRequest, NativeTtsCapabilities,
    NativeTtsChunkResponse, NativeTtsModelInstallResponse, NativeTtsModelStatus,
};

#[cfg(feature = "native-tts-core")]
use super::engine::{
    cancel_audiobook_save, delete_audiobook_native, export_audiobook_native,
    get_imported_audiobook_source, get_native_audiobook_chunk, import_audiobook_native,
    install_model, model_status, native_audiobook_status, native_capabilities,
    save_audiobook_native,
};

#[cfg(not(feature = "native-tts-core"))]
use super::stub::{
    cancel_audiobook_save, delete_audiobook_native, export_audiobook_native,
    get_imported_audiobook_source, get_native_audiobook_chunk, import_audiobook_native,
    install_model, model_status, native_audiobook_status, native_capabilities,
    save_audiobook_native,
};

/// Is native TTS usable on this build/device, and is the voice model installed?
#[tauri::command]
pub fn tts_native_capabilities(app: tauri::AppHandle) -> NativeTtsCapabilities {
    native_capabilities(app)
}

/// Voice-model install state (installed?/installing?, size, source metadata).
#[tauri::command]
pub fn tts_model_status(
    app: tauri::AppHandle,
    state: tauri::State<'_, NativeTtsState>,
) -> NativeTtsModelStatus {
    model_status(app, state)
}

/// Download + install the pinned voice model (one-time, idempotent).
#[tauri::command]
pub async fn tts_install_model(
    app: tauri::AppHandle,
    state: tauri::State<'_, NativeTtsState>,
) -> Result<NativeTtsModelInstallResponse, String> {
    install_model(app, state).await
}

/// How many of a document's chunks are already saved (for the "Saved" UI).
#[tauri::command]
pub fn tts_native_audiobook_status(
    app: tauri::AppHandle,
    request: NativeAudiobookStatusRequest,
) -> Result<NativeAudiobookStatusResponse, String> {
    native_audiobook_status(app, request)
}

/// Read one already-saved chunk WAV from the cache (returns a base64 WAV).
#[tauri::command]
pub fn tts_get_native_audiobook_chunk(
    app: tauri::AppHandle,
    request: NativeAudiobookChunkRequest,
) -> Result<NativeTtsChunkResponse, String> {
    get_native_audiobook_chunk(app, request)
}

/// Start (or resume) a full-audiobook save; streams progress events as it runs.
#[tauri::command]
pub async fn tts_save_audiobook_native(
    app: tauri::AppHandle,
    state: tauri::State<'_, NativeTtsState>,
    request: NativeAudiobookSaveRequest,
) -> Result<NativeAudiobookSaveResponse, String> {
    save_audiobook_native(app, state, request).await
}

/// Request cancellation of an in-progress save by job id.
#[tauri::command]
pub fn tts_cancel_audiobook_save(
    state: tauri::State<'_, NativeTtsState>,
    job_id: String,
) -> Result<(), String> {
    cancel_audiobook_save(state, job_id)
}

/// Export a saved audiobook to a single `.papercut-audiobook` bundle file.
///
/// Wrapped in `spawn_blocking` because the export does synchronous file I/O;
/// this keeps the async UI thread responsive while it runs.
#[tauri::command]
pub async fn tts_export_audiobook_native(
    app: tauri::AppHandle,
    request: NativeAudiobookExportRequest,
) -> Result<NativeAudiobookExportResponse, String> {
    tauri::async_runtime::spawn_blocking(move || export_audiobook_native(app, request))
        .await
        .map_err(|err| format!("Native audiobook export task failed: {err}"))?
}

/// Import a `.papercut-audiobook` bundle and restore it into app data.
#[tauri::command]
pub async fn tts_import_audiobook_native(
    app: tauri::AppHandle,
) -> Result<NativeAudiobookImportResponse, String> {
    tauri::async_runtime::spawn_blocking(move || import_audiobook_native(app))
        .await
        .map_err(|err| format!("Native audiobook import task failed: {err}"))?
}

/// Read the stored source HTML of an imported audiobook document.
#[tauri::command]
pub fn tts_get_imported_audiobook_source(
    app: tauri::AppHandle,
    request: NativeImportedAudiobookSourceRequest,
) -> Result<String, String> {
    get_imported_audiobook_source(app, request)
}

/// Delete saved audio, including recovered historical caches when requested,
/// and optionally remove the imported source document.
#[tauri::command]
pub async fn tts_delete_audiobook_native(
    app: tauri::AppHandle,
    request: NativeAudiobookDeleteRequest,
) -> Result<NativeAudiobookDeleteResponse, String> {
    tauri::async_runtime::spawn_blocking(move || delete_audiobook_native(app, request))
        .await
        .map_err(|err| format!("Native audiobook delete task failed: {err}"))?
}
