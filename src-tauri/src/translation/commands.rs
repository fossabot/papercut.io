//! Tauri command edge for offline translation.
//!
//! Commands are intentionally thin. The current backend is a stub that reports
//! planned capabilities without doing model download or translation work; future
//! engine commits should keep this command layer stable and move blocking work
//! onto `spawn_blocking` just like document uploads and native TTS.

use super::storage::{
    delete_translated_document as delete_translated_document_storage,
    list_translated_documents as list_translated_documents_storage,
};
use super::stub::{
    cancel_translation as cancel_translation_backend,
    start_translation as start_translation_backend,
    translation_capabilities as translation_capabilities_backend,
    translation_model_status as translation_model_status_backend,
};
use super::types::{
    TranslatedDocumentInfo, TranslationCancelRequest, TranslationCapabilities,
    TranslationDeleteRequest, TranslationDeleteResponse, TranslationModelStatus,
    TranslationModelStatusRequest, TranslationStartRequest, TranslationStartResponse,
};

/// Return planned offline translation capabilities and candidate catalog entries.
#[tauri::command]
pub fn translation_capabilities() -> TranslationCapabilities {
    translation_capabilities_backend()
}

/// Return install status for a planned translation model.
#[tauri::command]
pub fn translation_model_status<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    request: TranslationModelStatusRequest,
) -> TranslationModelStatus {
    translation_model_status_backend(&app, request)
}

/// Start a document translation job once a real engine exists.
#[tauri::command]
pub async fn translation_start<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    request: TranslationStartRequest,
) -> Result<TranslationStartResponse, String> {
    tauri::async_runtime::spawn_blocking(move || start_translation_backend(&app, request))
        .await
        .map_err(|err| format!("Translation start task failed: {err}"))?
}

/// Request cancellation for a translation job.
#[tauri::command]
pub fn translation_cancel(request: TranslationCancelRequest) -> Result<(), String> {
    cancel_translation_backend(request)
}

/// List durable translated document variants.
///
/// This command is real before inference exists so the frontend can be built
/// against the eventual library surface. It returns an empty list until a later
/// stage creates translated variants.
#[tauri::command]
pub async fn translation_list_documents<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
) -> Result<Vec<TranslatedDocumentInfo>, String> {
    tauri::async_runtime::spawn_blocking(move || list_translated_documents_storage(&app))
        .await
        .map_err(|err| format!("Translation list task failed: {err}"))?
}

/// Delete a translated document variant.
///
/// Delete is also real early because it defines an important safety boundary:
/// translated variants are disposable derived data, while original uploads stay
/// owned by `document_uploads`.
#[tauri::command]
pub async fn translation_delete_document<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    request: TranslationDeleteRequest,
) -> Result<TranslationDeleteResponse, String> {
    tauri::async_runtime::spawn_blocking(move || {
        delete_translated_document_storage(&app, &request.id)
    })
    .await
    .map_err(|err| format!("Translation delete task failed: {err}"))?
}
