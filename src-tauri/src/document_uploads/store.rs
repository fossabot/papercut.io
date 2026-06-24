//! SQLite persistence for uploaded documents.
//!
//! Owns the schema, the connection bootstrap, the index write path, listing,
//! and row deletion. Search-time reads live in [`super::search`]; this module
//! keeps everything that defines or mutates the database layout.

use rusqlite::{params, Connection};
use tauri::Runtime;

use super::parsed::ParsedDocument;
use super::storage::uploads_root;
use super::types::UploadedDocument;

/// List all stored uploads as DTOs, newest import first.
pub(crate) fn list_uploads<R: Runtime>(
    app: &tauri::AppHandle<R>,
) -> Result<Vec<UploadedDocument>, String> {
    let db = open_db(app)?;
    let mut stmt = db
        .prepare(
            "SELECT id, url, title, format, imported_at_ms, bytes, sections \
             FROM uploaded_documents ORDER BY imported_at_ms DESC",
        )
        .map_err(db_err)?;
    let rows = stmt
        .query_map([], |row| {
            Ok(UploadedDocument {
                id: row.get(0)?,
                url: row.get(1)?,
                title: row.get(2)?,
                format: row.get(3)?,
                imported_at_ms: row.get::<_, i64>(4)? as u128,
                bytes: row.get::<_, i64>(5)? as u64,
                sections: row.get::<_, i64>(6)? as usize,
            })
        })
        .map_err(db_err)?;

    rows.collect::<Result<Vec<_>, _>>().map_err(db_err)
}

/// Open (creating if needed) the search database and ensure the schema exists.
///
/// Idempotent: creates the storage dir, the metadata and section tables, and the
/// FTS5 virtual table on every call so callers never depend on prior setup.
pub(crate) fn open_db<R: Runtime>(app: &tauri::AppHandle<R>) -> Result<Connection, String> {
    let root = uploads_root(app)?;
    std::fs::create_dir_all(&root)
        .map_err(|err| format!("Failed to create upload storage {}: {err}", root.display()))?;
    let db = Connection::open(root.join("search.sqlite3")).map_err(db_err)?;
    db.execute_batch(
        "PRAGMA journal_mode = WAL;
         CREATE TABLE IF NOT EXISTS upload_schema_metadata (
           key TEXT PRIMARY KEY,
           value TEXT NOT NULL
         );
         INSERT OR IGNORE INTO upload_schema_metadata (key, value) VALUES ('schema_version', '1');
         CREATE TABLE IF NOT EXISTS uploaded_documents (
           id TEXT PRIMARY KEY,
           url TEXT NOT NULL UNIQUE,
           title TEXT NOT NULL,
           format TEXT NOT NULL,
           imported_at_ms INTEGER NOT NULL,
           bytes INTEGER NOT NULL,
           sections INTEGER NOT NULL
         );
         CREATE TABLE IF NOT EXISTS uploaded_sections (
           id INTEGER PRIMARY KEY AUTOINCREMENT,
           document_id TEXT NOT NULL,
           ordinal INTEGER NOT NULL,
           heading TEXT,
           text TEXT NOT NULL,
           FOREIGN KEY(document_id) REFERENCES uploaded_documents(id) ON DELETE CASCADE
         );
         CREATE VIRTUAL TABLE IF NOT EXISTS uploaded_document_fts USING fts5(
           document_id UNINDEXED,
           section_id UNINDEXED,
           title,
           heading,
           text,
           tokenize = 'porter unicode61 remove_diacritics 1'
         );",
    )
    .map_err(db_err)?;
    Ok(db)
}

/// Remove a document's metadata, section, and FTS rows in one transaction so
/// the index and metadata can never drift out of sync.
pub(crate) fn delete_document_rows(db: &mut Connection, id: &str) -> Result<(), String> {
    let tx = db.transaction().map_err(db_err)?;
    tx.execute(
        "DELETE FROM uploaded_document_fts WHERE document_id = ?1",
        [id],
    )
    .map_err(db_err)?;
    tx.execute("DELETE FROM uploaded_sections WHERE document_id = ?1", [id])
        .map_err(db_err)?;
    tx.execute("DELETE FROM uploaded_documents WHERE id = ?1", [id])
        .map_err(db_err)?;
    tx.commit().map_err(db_err)
}

/// Insert or replace a parsed document and all of its sections atomically,
/// rewriting the metadata, section, and FTS rows for the given id.
pub(crate) fn upsert_document(
    db: &mut Connection,
    id: &str,
    url: &str,
    parsed: &ParsedDocument,
    imported_at_ms: u128,
    bytes: u64,
) -> Result<(), String> {
    let tx = db.transaction().map_err(db_err)?;
    tx.execute(
        "DELETE FROM uploaded_document_fts WHERE document_id = ?1",
        [id],
    )
    .map_err(db_err)?;
    tx.execute("DELETE FROM uploaded_sections WHERE document_id = ?1", [id])
        .map_err(db_err)?;
    tx.execute(
        "INSERT OR REPLACE INTO uploaded_documents \
         (id, url, title, format, imported_at_ms, bytes, sections) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![
            id,
            url,
            parsed.title,
            parsed.format,
            imported_at_ms as i64,
            bytes as i64,
            parsed.sections.len() as i64,
        ],
    )
    .map_err(db_err)?;

    for (index, section) in parsed.sections.iter().enumerate() {
        tx.execute(
            "INSERT INTO uploaded_sections (document_id, ordinal, heading, text) \
             VALUES (?1, ?2, ?3, ?4)",
            params![id, index as i64, section.heading, section.text],
        )
        .map_err(db_err)?;
        let section_id = tx.last_insert_rowid();
        tx.execute(
            "INSERT INTO uploaded_document_fts (document_id, section_id, title, heading, text) \
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![id, section_id, parsed.title, section.heading, section.text],
        )
        .map_err(db_err)?;
    }

    tx.commit().map_err(db_err)
}

/// Format a rusqlite error into the feature's user-facing error string.
pub(crate) fn db_err(err: rusqlite::Error) -> String {
    format!("Document upload database error: {err}")
}
