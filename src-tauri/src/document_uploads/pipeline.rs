//! Import / get-source / delete orchestration.
//!
//! These functions sequence the parser, storage, and SQLite store together but
//! contain no parsing, SQL, or path logic themselves — that lives in [`super::html`],
//! [`super::store`], and [`super::storage`]. They run on the blocking thread pool
//! (see [`super::commands`]).

use std::fs;
use std::io::Read;

use tauri::Runtime;
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_fs::FsExt;

use super::html::parse_html_document;
use super::storage::{
    now_ms, upload_dir, upload_id, upload_id_from_url, MAX_UPLOAD_BYTES, UPLOAD_URL_PREFIX,
};
use super::store::{delete_document_rows, open_db, upsert_document};
use super::storage::directory_size;
use super::types::{
    UploadedDocument, UploadedDocumentDeleteRequest, UploadedDocumentDeleteResult,
    UploadedDocumentSourceRequest,
};

/// Full import path: pick a file, enforce size/UTF-8 limits, parse and sanitize
/// it, store the sanitized source under app data, and index it into SQLite.
pub(crate) fn import_html<R: Runtime>(
    app: tauri::AppHandle<R>,
) -> Result<UploadedDocument, String> {
    let source = app
        .dialog()
        .file()
        .set_title("Import HTML Document")
        .add_filter("HTML Document", &["html", "htm"])
        .blocking_pick_file()
        .ok_or_else(|| "Document import cancelled".to_string())?;

    let mut options = tauri_plugin_fs::OpenOptions::new();
    options.read(true);
    let mut file = app
        .fs()
        .open(source, options)
        .map_err(|err| format!("Failed to open selected HTML document: {err}"))?;
    let mut bytes = Vec::new();
    file.by_ref()
        .take(MAX_UPLOAD_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|err| format!("Failed to read selected HTML document: {err}"))?;
    if bytes.len() as u64 > MAX_UPLOAD_BYTES {
        return Err("HTML document is larger than the 25 MB import limit".into());
    }
    let html = String::from_utf8(bytes)
        .map_err(|_| "HTML document must be valid UTF-8 for this first import path".to_string())?;

    let parsed = parse_html_document(&html);
    if parsed.sections.is_empty() {
        return Err("HTML document did not contain readable text".into());
    }

    let imported_at_ms = now_ms()?;
    let id = upload_id(&parsed.title, &parsed.sections, imported_at_ms);
    let url = format!("{UPLOAD_URL_PREFIX}{id}.html");
    let dir = upload_dir(&app, &id)?;
    fs::create_dir_all(&dir)
        .map_err(|err| format!("Failed to create upload directory {}: {err}", dir.display()))?;
    fs::write(dir.join("source.html"), parsed.sanitized_html.as_bytes())
        .map_err(|err| format!("Failed to write imported HTML document: {err}"))?;

    let mut db = open_db(&app)?;
    upsert_document(
        &mut db,
        &id,
        &url,
        &parsed,
        imported_at_ms,
        html.len() as u64,
    )?;

    Ok(UploadedDocument {
        id,
        url,
        title: parsed.title,
        format: "html".into(),
        imported_at_ms,
        bytes: html.len() as u64,
        sections: parsed.sections.len(),
    })
}

/// Resolve an uploaded document URL to its stored source file and return its HTML.
pub(crate) fn get_source<R: Runtime>(
    app: &tauri::AppHandle<R>,
    request: UploadedDocumentSourceRequest,
) -> Result<String, String> {
    let id = upload_id_from_url(&request.document_url)?;
    let path = upload_dir(app, &id)?.join("source.html");
    fs::read_to_string(&path)
        .map_err(|err| format!("Failed to read uploaded document {}: {err}", path.display()))
}

/// Delete one upload: remove its stored directory and all of its SQLite rows,
/// reporting how many bytes the directory freed.
pub(crate) fn delete_upload<R: Runtime>(
    app: &tauri::AppHandle<R>,
    request: UploadedDocumentDeleteRequest,
) -> Result<UploadedDocumentDeleteResult, String> {
    let id = upload_id_from_url(&request.document_url)?;
    let dir = upload_dir(app, &id)?;
    let bytes_freed = directory_size(&dir)?;
    let mut db = open_db(app)?;

    if dir.exists() {
        fs::remove_dir_all(&dir).map_err(|err| {
            format!(
                "Failed to delete uploaded document files {}: {err}",
                dir.display()
            )
        })?;
    }

    // Delete search rows in one transaction so the FTS table and metadata cannot drift apart.
    delete_document_rows(&mut db, &id)?;

    Ok(UploadedDocumentDeleteResult {
        id,
        url: request.document_url,
        bytes_freed,
    })
}
