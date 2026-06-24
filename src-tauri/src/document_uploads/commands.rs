//! The `#[tauri::command]` edge.
//!
//! Each command is a thin wrapper: it moves the blocking pipeline/store/search
//! work onto the blocking thread pool so the async runtime is never stalled by
//! filesystem or SQLite I/O, then maps a join error into a `String`. All real
//! logic lives in the modules these delegate to.

use tauri::Runtime;

use super::pipeline::{delete_upload, get_source, import_epub, import_html};
use super::search::search_uploads;
use super::store::list_uploads;
use super::types::{
    UploadedDocument, UploadedDocumentDeleteRequest, UploadedDocumentDeleteResult,
    UploadedDocumentSearchRequest, UploadedDocumentSearchResult, UploadedDocumentSourceRequest,
};

/// Open the native picker, import the chosen HTML file, and return its metadata.
#[tauri::command]
pub async fn document_uploads_import_html<R: Runtime>(
    app: tauri::AppHandle<R>,
) -> Result<UploadedDocument, String> {
    tauri::async_runtime::spawn_blocking(move || import_html(app))
        .await
        .map_err(|err| format!("Document import task failed: {err}"))?
}

/// Open the native picker, import the chosen EPUB file, and return its metadata.
#[tauri::command]
pub async fn document_uploads_import_epub<R: Runtime>(
    app: tauri::AppHandle<R>,
) -> Result<UploadedDocument, String> {
    tauri::async_runtime::spawn_blocking(move || import_epub(app))
        .await
        .map_err(|err| format!("Document import task failed: {err}"))?
}

/// List all stored uploads, newest first.
#[tauri::command]
pub async fn document_uploads_list<R: Runtime>(
    app: tauri::AppHandle<R>,
) -> Result<Vec<UploadedDocument>, String> {
    tauri::async_runtime::spawn_blocking(move || list_uploads(&app))
        .await
        .map_err(|err| format!("Document upload list task failed: {err}"))?
}

/// Run a full-text search across uploaded documents.
#[tauri::command]
pub async fn document_uploads_search<R: Runtime>(
    app: tauri::AppHandle<R>,
    request: UploadedDocumentSearchRequest,
) -> Result<Vec<UploadedDocumentSearchResult>, String> {
    tauri::async_runtime::spawn_blocking(move || search_uploads(&app, request))
        .await
        .map_err(|err| format!("Document upload search task failed: {err}"))?
}

/// Read the stored sanitized source HTML for an uploaded document URL.
#[tauri::command]
pub async fn document_uploads_get_source<R: Runtime>(
    app: tauri::AppHandle<R>,
    request: UploadedDocumentSourceRequest,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || get_source(&app, request))
        .await
        .map_err(|err| format!("Document upload source task failed: {err}"))?
}

/// Delete an uploaded document's rows and stored source directory.
#[tauri::command]
pub async fn document_uploads_delete<R: Runtime>(
    app: tauri::AppHandle<R>,
    request: UploadedDocumentDeleteRequest,
) -> Result<UploadedDocumentDeleteResult, String> {
    tauri::async_runtime::spawn_blocking(move || delete_upload(&app, request))
        .await
        .map_err(|err| format!("Document upload delete task failed: {err}"))?
}
