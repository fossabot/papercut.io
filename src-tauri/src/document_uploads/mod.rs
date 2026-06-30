//! Runtime user-document upload feature.
//!
//! Splits the upload pipeline into focused submodules so each concern can grow
//! independently. Dependencies only point downward:
//!
//! ```text
//! commands -> pipeline -> { epub, html, parsed, store, search, storage } -> types
//! ```
//!
//! - [`commands`]: the thin `#[tauri::command]` edge exposed to the frontend.
//! - [`pipeline`]: orchestrates import / get-source / delete.
//! - [`html`]: HTML-specific parsing + sanitization.
//! - [`epub`]: EPUB-specific parsing, sanitization, and generated reading HTML.
//! - [`organization`]: folder and manual ordering metadata for uploaded docs.
//! - [`parsed`]: format-neutral parsed document shape.
//! - [`store`]: SQLite schema, persistence, and listing.
//! - [`search`]: FTS5 query building and execution.
//! - [`storage`]: filesystem paths, upload ids, size accounting, clock.
//! - [`types`]: serde DTOs shared across the boundary.

// `commands` is `pub(crate)` so `generate_handler!` in `lib.rs` can reach both
// each command and the hidden `__cmd__*` helper the macro generates beside it.
pub(crate) mod commands;
mod epub;
mod html;
mod organization;
mod parsed;
mod pipeline;
mod search;
mod storage;
mod store;
mod types;

pub(crate) struct DerivedDocumentSection {
    pub(crate) heading: Option<String>,
    pub(crate) text: String,
}

/// Shared SQLite connection bootstrap for translated document variants.
///
/// Translation needs to list and delete derived documents beside uploads, but
/// it should not make the upload store public or depend on parser internals.
/// This small seam exposes only the database bootstrap contract.
pub(crate) fn open_document_uploads_db<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
) -> Result<rusqlite::Connection, String> {
    store::open_db(app)
}

/// Persist a generated document variant through the same reader/search contract
/// as imports without exposing parser-private `ParsedDocument` outside this
/// feature.
///
/// The source file is written through a staging directory first. Once the file
/// is complete, the directory is promoted and only then are reader/search rows
/// upserted. If the database write fails, the promoted directory is removed so
/// generated variants do not leave half-visible files behind.
pub(crate) fn persist_derived_document<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    id: &str,
    url: &str,
    title: &str,
    format: &str,
    view_html: String,
    sections: Vec<DerivedDocumentSection>,
    imported_at_ms: u128,
    bytes: u64,
) -> Result<(), String> {
    let dir = storage::upload_dir(app, id)?;
    let staging_dir = storage::upload_dir(app, &format!("{id}.staging"))?;
    if staging_dir.exists() {
        std::fs::remove_dir_all(&staging_dir).map_err(|err| {
            format!(
                "Failed to clear stale derived document staging directory {}: {err}",
                staging_dir.display()
            )
        })?;
    }
    std::fs::create_dir_all(&staging_dir).map_err(|err| {
        format!(
            "Failed to create derived document staging directory {}: {err}",
            staging_dir.display()
        )
    })?;
    if let Err(err) = std::fs::write(staging_dir.join("source.html"), view_html.as_bytes()) {
        let _ = std::fs::remove_dir_all(&staging_dir);
        return Err(format!("Failed to write derived document source: {err}"));
    }
    if dir.exists() {
        let _ = std::fs::remove_dir_all(&staging_dir);
        return Err(format!(
            "Derived document directory already exists: {}",
            dir.display()
        ));
    }
    if let Err(err) = std::fs::rename(&staging_dir, &dir) {
        let _ = std::fs::remove_dir_all(&staging_dir);
        return Err(format!(
            "Failed to promote derived document directory {}: {err}",
            dir.display()
        ));
    }

    let parsed = parsed::ParsedDocument {
        title: title.into(),
        format: format.into(),
        view_html,
        sections: sections
            .into_iter()
            .map(|section| parsed::ParsedSection {
                heading: section.heading,
                text: section.text,
            })
            .collect(),
    };
    let mut db = store::open_db(app)?;
    if let Err(err) = store::upsert_document(&mut db, id, url, &parsed, imported_at_ms, bytes) {
        let _ = std::fs::remove_dir_all(&dir);
        return Err(err);
    }
    Ok(())
}

/// Delete a generated document variant from the upload/search store by id.
pub(crate) fn delete_derived_document<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    id: &str,
) -> Result<u64, String> {
    let dir = storage::upload_dir(app, id)?;
    let bytes_freed = storage::directory_size(&dir)?;
    let mut db = store::open_db(app)?;
    if dir.exists() {
        std::fs::remove_dir_all(&dir).map_err(|err| {
            format!(
                "Failed to delete derived document directory {}: {err}",
                dir.display()
            )
        })?;
    }
    store::delete_document_rows(&mut db, id)?;
    Ok(bytes_freed)
}
