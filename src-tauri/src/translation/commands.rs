//! Tauri command edge for offline translation.
//!
//! Commands are intentionally thin. The current backend is a stub that reports
//! planned capabilities without doing model download or translation work; future
//! engine commits should keep this command layer stable and move blocking work
//! onto `spawn_blocking` just like document uploads and native TTS.

use super::stub::{
    cancel_translation as cancel_translation_backend,
    delete_translated_document as delete_translated_document_backend,
    list_translated_documents as list_translated_documents_backend,
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
pub fn translation_model_status(request: TranslationModelStatusRequest) -> TranslationModelStatus {
    translation_model_status_backend(request)
}

/// Start a document translation job once a real engine exists.
#[tauri::command]
pub fn translation_start(
    request: TranslationStartRequest,
) -> Result<TranslationStartResponse, String> {
    start_translation_backend(request)
}

/// Request cancellation for a translation job.
#[tauri::command]
pub fn translation_cancel(request: TranslationCancelRequest) -> Result<(), String> {
    cancel_translation_backend(request)
}

/// List durable translated document variants.
#[tauri::command]
pub fn translation_list_documents() -> Vec<TranslatedDocumentInfo> {
    list_translated_documents_backend()
}

/// Delete a translated document variant.
#[tauri::command]
pub fn translation_delete_document(request: TranslationDeleteRequest) -> TranslationDeleteResponse {
    delete_translated_document_backend(request)
}
