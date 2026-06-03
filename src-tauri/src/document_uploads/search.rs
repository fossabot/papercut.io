//! FTS5 query building and execution for uploaded documents.
//!
//! Read-only against the schema owned by [`super::store`]. Kept separate so
//! query/ranking behavior can evolve without touching the write path.

use rusqlite::params;
use tauri::Runtime;

use super::store::{db_err, open_db};
use super::types::{UploadedDocumentSearchRequest, UploadedDocumentSearchResult};

/// Run an FTS5 MATCH query, joining hits back to their section and document and
/// returning BM25-ranked results with `<mark>`-highlighted snippets.
pub(crate) fn search_uploads<R: Runtime>(
    app: &tauri::AppHandle<R>,
    request: UploadedDocumentSearchRequest,
) -> Result<Vec<UploadedDocumentSearchResult>, String> {
    let query = fts_query(&request.query);
    if query.is_empty() {
        return Ok(Vec::new());
    }

    let db = open_db(app)?;
    let limit = request.limit.unwrap_or(50).clamp(1, 100) as i64;
    let mut stmt = db
        .prepare(
            "SELECT d.id, d.url, d.title, s.ordinal, s.heading, \
                    snippet(uploaded_document_fts, 3, '<mark>', '</mark>', '…', 18) AS excerpt \
             FROM uploaded_document_fts \
             JOIN uploaded_sections s ON s.id = uploaded_document_fts.section_id \
             JOIN uploaded_documents d ON d.id = uploaded_document_fts.document_id \
             WHERE uploaded_document_fts MATCH ?1 \
             ORDER BY bm25(uploaded_document_fts), d.imported_at_ms DESC \
             LIMIT ?2",
        )
        .map_err(db_err)?;
    let rows = stmt
        .query_map(params![query, limit], |row| {
            let document_id: String = row.get(0)?;
            let section_index: i64 = row.get(3)?;
            Ok(UploadedDocumentSearchResult {
                id: format!("upload:{document_id}:{section_index}"),
                document_id,
                url: row.get(1)?,
                title: row.get(2)?,
                section_index: section_index as usize,
                section_title: row.get(4)?,
                excerpt: row.get(5)?,
            })
        })
        .map_err(db_err)?;

    rows.collect::<Result<Vec<_>, _>>().map_err(db_err)
}

/// Turn a raw user query into a safe FTS5 expression: split on non-alphanumerics,
/// keep at most 12 terms, quote each (stripping embedded quotes), and AND them.
fn fts_query(query: &str) -> String {
    query
        .split(|ch: char| !ch.is_alphanumeric() && ch != '_')
        .filter(|part| !part.is_empty())
        .take(12)
        .map(|term| format!("\"{}\"", term.replace('"', "")))
        .collect::<Vec<_>>()
        .join(" AND ")
}
