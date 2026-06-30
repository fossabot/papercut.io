//! SQLite and filesystem storage for translated document variants.
//!
//! Translation variants live beside uploaded documents because they should be
//! searchable/openable through the same runtime-library path later. This module
//! owns only translation metadata and variant directories; it never mutates the
//! original uploaded document rows or source files.

use std::fs;
use std::path::{Path, PathBuf};

use rusqlite::{params, OptionalExtension};
use tauri::{Manager, Runtime};

use crate::document_uploads::open_document_uploads_db;

use super::types::{TranslatedDocumentInfo, TranslationDeleteResponse};

const TRANSLATION_SCHEMA_VERSION: &str = "1";

pub(super) fn list_translated_documents<R: Runtime>(
    app: &tauri::AppHandle<R>,
) -> Result<Vec<TranslatedDocumentInfo>, String> {
    let db = open_translation_db(app)?;
    let mut stmt = db
        .prepare(
            "SELECT id, source_document_url, title, source_language, target_language, \
                    model_id, status, created_at_ms, updated_at_ms \
             FROM translated_documents ORDER BY updated_at_ms DESC",
        )
        .map_err(db_err)?;
    let rows = stmt
        .query_map([], |row| {
            Ok(TranslatedDocumentInfo {
                id: row.get(0)?,
                source_document_url: row.get(1)?,
                title: row.get(2)?,
                source_language: row.get(3)?,
                target_language: row.get(4)?,
                model_id: row.get(5)?,
                status: row.get(6)?,
                created_at_ms: row.get::<_, i64>(7)? as u128,
                updated_at_ms: row.get::<_, i64>(8)? as u128,
            })
        })
        .map_err(db_err)?;

    rows.collect::<Result<Vec<_>, _>>().map_err(db_err)
}

/// Delete one translated variant without touching the original source document.
///
/// Translation variants are derived artifacts: deleting one should behave like
/// deleting saved audiobook audio, not like deleting the imported HTML/EPUB.
/// The row deletion and directory deletion are deliberately scoped to the
/// translation id. A source upload can outlive all variants, and a missing row
/// is treated as an idempotent no-op so UI cleanup can retry safely.
pub(super) fn delete_translated_document<R: Runtime>(
    app: &tauri::AppHandle<R>,
    id: &str,
) -> Result<TranslationDeleteResponse, String> {
    let mut db = open_translation_db(app)?;
    let variant_dir = translation_variant_dir(app, id)?;
    let bytes_freed = directory_size(&variant_dir)?;
    let tx = db.transaction().map_err(db_err)?;
    let deleted_rows = tx
        .execute("DELETE FROM translated_documents WHERE id = ?1", [id])
        .map_err(db_err)?;
    tx.commit().map_err(db_err)?;

    if variant_dir.exists() {
        fs::remove_dir_all(&variant_dir).map_err(|err| {
            format!(
                "Failed to delete translated document files {}: {err}",
                variant_dir.display()
            )
        })?;
    }

    Ok(TranslationDeleteResponse {
        id: id.into(),
        deleted: deleted_rows > 0,
        bytes_freed,
        message: if deleted_rows > 0 {
            "Deleted translated document variant".into()
        } else {
            "Translated document variant was not found".into()
        },
    })
}

fn open_translation_db<R: Runtime>(
    app: &tauri::AppHandle<R>,
) -> Result<rusqlite::Connection, String> {
    let db = open_document_uploads_db(app)?;
    ensure_translation_schema(&db)?;
    Ok(db)
}

/// Create translation tables inside the existing runtime upload/search DB.
///
/// Keeping variants in the upload database makes future joins cheap: translated
/// copies can point back to uploaded source documents, share delete/list flows,
/// and later promote their generated HTML into the same reader/search contract.
/// The schema is additive only; uploaded document rows and FTS rows are not
/// changed by this bootstrap.
fn ensure_translation_schema(db: &rusqlite::Connection) -> Result<(), String> {
    db.execute_batch(
        "PRAGMA foreign_keys = ON;
         INSERT OR REPLACE INTO upload_schema_metadata (key, value)
           VALUES ('translation_schema_version', '1');
         CREATE TABLE IF NOT EXISTS translated_documents (
           id TEXT PRIMARY KEY,
           source_document_id TEXT,
           source_document_url TEXT NOT NULL,
           title TEXT NOT NULL,
           source_language TEXT NOT NULL,
           target_language TEXT NOT NULL,
           model_id TEXT NOT NULL,
           engine_id TEXT NOT NULL,
           quality_mode TEXT NOT NULL,
           settings_json TEXT NOT NULL,
           glossary_hash TEXT,
           status TEXT NOT NULL,
           source_path TEXT NOT NULL,
           created_at_ms INTEGER NOT NULL,
           updated_at_ms INTEGER NOT NULL,
           FOREIGN KEY(source_document_id) REFERENCES uploaded_documents(id) ON DELETE SET NULL
         );
         CREATE INDEX IF NOT EXISTS translated_documents_source_idx
           ON translated_documents(source_document_id, target_language, updated_at_ms);
         CREATE INDEX IF NOT EXISTS translated_documents_status_idx
           ON translated_documents(status, updated_at_ms);",
    )
    .map_err(db_err)?;

    let version: Option<String> = db
        .query_row(
            "SELECT value FROM upload_schema_metadata WHERE key = 'translation_schema_version'",
            [],
            |row| row.get(0),
        )
        .optional()
        .map_err(db_err)?;
    if version.as_deref() != Some(TRANSLATION_SCHEMA_VERSION) {
        return Err("Unexpected translation schema version".into());
    }

    Ok(())
}

/// Root for future translated safe-HTML files.
///
/// The directory intentionally lives under `document_uploads/` because
/// translated variants are user-document derivatives, not model caches. Model
/// files should live in a separate translation model cache once an engine lands.
fn translations_root<R: Runtime>(app: &tauri::AppHandle<R>) -> Result<PathBuf, String> {
    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|err| format!("Failed to resolve app data dir for translations: {err}"))?;
    Ok(app_data.join("document_uploads").join("translations"))
}

/// Resolve one translated-variant directory while rejecting path-like ids.
///
/// The id will eventually come from translation metadata and possibly the
/// frontend. Restricting it to a boring slug here prevents accidental path
/// traversal before any filesystem operation touches app data.
fn translation_variant_dir<R: Runtime>(
    app: &tauri::AppHandle<R>,
    id: &str,
) -> Result<PathBuf, String> {
    if id.is_empty()
        || !id
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == '-' || ch == '_')
    {
        return Err("Translated document id is invalid".into());
    }
    Ok(translations_root(app)?.join(id))
}

fn directory_size(path: &Path) -> Result<u64, String> {
    if !path.exists() {
        return Ok(0);
    }
    let metadata = fs::metadata(path).map_err(|err| {
        format!(
            "Failed to inspect translated document storage {}: {err}",
            path.display()
        )
    })?;
    if metadata.is_file() {
        return Ok(metadata.len());
    }

    let mut total = 0;
    for entry in fs::read_dir(path).map_err(|err| {
        format!(
            "Failed to read translated document storage {}: {err}",
            path.display()
        )
    })? {
        let entry = entry.map_err(|err| format!("Failed to inspect translated file: {err}"))?;
        total += directory_size(&entry.path())?;
    }
    Ok(total)
}

fn db_err(err: rusqlite::Error) -> String {
    format!("Translation database error: {err}")
}

#[cfg(test)]
mod tests {
    use rusqlite::Connection;

    use super::ensure_translation_schema;

    #[test]
    fn schema_bootstrap_is_idempotent() {
        let db = Connection::open_in_memory().expect("db");
        db.execute_batch(
            "CREATE TABLE upload_schema_metadata (
               key TEXT PRIMARY KEY,
               value TEXT NOT NULL
             );
             CREATE TABLE uploaded_documents (
               id TEXT PRIMARY KEY,
               url TEXT NOT NULL UNIQUE,
               title TEXT NOT NULL,
               format TEXT NOT NULL,
               imported_at_ms INTEGER NOT NULL,
               bytes INTEGER NOT NULL,
               sections INTEGER NOT NULL
             );",
        )
        .expect("base schema");

        ensure_translation_schema(&db).expect("first bootstrap");
        ensure_translation_schema(&db).expect("second bootstrap");

        let version: String = db
            .query_row(
                "SELECT value FROM upload_schema_metadata WHERE key = 'translation_schema_version'",
                [],
                |row| row.get(0),
            )
            .expect("version");
        assert_eq!(version, "1");
    }
}
