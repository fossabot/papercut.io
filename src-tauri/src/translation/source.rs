//! Source-document reads for translation jobs.
//!
//! Upload parsers already normalize HTML/EPUB into `uploaded_sections` and a
//! sanitized reader HTML file. Translation consumes both: sections drive stable
//! batching/search text, while reader HTML lets rendered translations preserve
//! document structure where possible.

#![allow(dead_code)]

use rusqlite::{params, OptionalExtension};
use tauri::Runtime;

use crate::document_uploads::{open_document_uploads_db, read_uploaded_document_source};

use super::inline_markup::source_text_blocks_excluding_nontranslatable_markers;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct TranslationSourceDocument {
    pub(crate) document_id: String,
    pub(crate) document_url: String,
    pub(crate) title: String,
    pub(crate) format: String,
    pub(crate) view_html: String,
    pub(crate) blocks: Vec<TranslationSourceBlock>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct TranslationSourceBlock {
    pub(crate) ordinal: usize,
    pub(crate) heading: Option<String>,
    pub(crate) text: String,
}

/// Load the ordered text blocks for an uploaded document URL.
///
/// The caller supplies the same virtual document URL used by the reader and
/// TTS. Looking up by URL keeps translation independent from upload ids while
/// still letting storage retain the real `document_id` for future joins.
pub(crate) fn load_translation_source_document<R: Runtime>(
    app: &tauri::AppHandle<R>,
    document_url: &str,
) -> Result<TranslationSourceDocument, String> {
    let db = open_document_uploads_db(app)?;
    let mut source = query_translation_source_document(&db, document_url)?;
    source.view_html = read_uploaded_document_source(app, document_url)?;
    apply_marker_free_reader_text(&mut source);
    Ok(source)
}

/// Prefer reader-DOM text when it maps exactly to uploaded sections.
///
/// The DB section text is plain extraction from upload time, so footnote labels
/// embedded in anchors can look like prose (`topic1`) and leak into MT output.
/// Reader HTML still has marker structure, letting us strip those labels before
/// translation while keeping persisted ordinals/headings unchanged.
fn apply_marker_free_reader_text(source: &mut TranslationSourceDocument) {
    let blocks = source_text_blocks_excluding_nontranslatable_markers(&source.view_html);
    if blocks.len() != source.blocks.len() {
        return;
    }
    for (block, text) in source.blocks.iter_mut().zip(blocks) {
        if !text.trim().is_empty() {
            block.text = text;
        }
    }
}

fn query_translation_source_document(
    db: &rusqlite::Connection,
    document_url: &str,
) -> Result<TranslationSourceDocument, String> {
    let metadata = db
        .query_row(
            "SELECT id, url, title, format FROM uploaded_documents WHERE url = ?1",
            [document_url],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                ))
            },
        )
        .optional()
        .map_err(db_err)?;
    let Some((document_id, document_url, title, format)) = metadata else {
        return Err("Source document was not found for translation".into());
    };

    let mut stmt = db
        .prepare(
            "SELECT ordinal, heading, text \
             FROM uploaded_sections \
             WHERE document_id = ?1 \
             ORDER BY ordinal ASC",
        )
        .map_err(db_err)?;
    let blocks = stmt
        .query_map(params![&document_id], |row| {
            let ordinal = row.get::<_, i64>(0)?;
            let ordinal = usize::try_from(ordinal)
                .map_err(|_| rusqlite::Error::IntegralValueOutOfRange(0, ordinal))?;
            Ok(TranslationSourceBlock {
                ordinal,
                heading: row.get(1)?,
                text: row.get(2)?,
            })
        })
        .map_err(db_err)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(db_err)?;

    if blocks.is_empty() {
        return Err("Source document has no translatable sections".into());
    }

    Ok(TranslationSourceDocument {
        document_id,
        document_url,
        title,
        format,
        view_html: String::new(),
        blocks,
    })
}

fn db_err(err: rusqlite::Error) -> String {
    format!("Translation source database error: {err}")
}

#[cfg(test)]
mod tests {
    use rusqlite::Connection;

    use super::query_translation_source_document;

    #[test]
    fn reads_sections_in_document_order_by_url() {
        let db = test_db();

        let source =
            query_translation_source_document(&db, "/user-uploads/book.html").expect("source");

        assert_eq!(source.document_id, "doc1");
        assert_eq!(source.document_url, "/user-uploads/book.html");
        assert_eq!(source.title, "Book");
        assert_eq!(source.format, "html");
        assert_eq!(source.view_html, "");
        assert_eq!(source.blocks.len(), 2);
        assert_eq!(source.blocks[0].ordinal, 0);
        assert_eq!(source.blocks[0].heading.as_deref(), Some("Intro"));
        assert_eq!(source.blocks[0].text, "First block");
        assert_eq!(source.blocks[1].ordinal, 1);
        assert_eq!(source.blocks[1].heading.as_deref(), Some("Chapter"));
        assert_eq!(source.blocks[1].text, "Second block");
    }

    #[test]
    fn rejects_missing_document_url() {
        let db = test_db();
        let error =
            query_translation_source_document(&db, "/missing.html").expect_err("missing document");

        assert!(error.contains("not found"));
    }

    #[test]
    fn rejects_document_without_sections() {
        let db = test_db_with_empty_document();
        let error =
            query_translation_source_document(&db, "/empty.html").expect_err("empty document");

        assert!(error.contains("no translatable sections"));
    }

    fn test_db() -> Connection {
        let db = test_schema();
        db.execute(
            "INSERT INTO uploaded_documents \
             (id, url, title, format, imported_at_ms, bytes, sections) \
             VALUES ('doc1', '/user-uploads/book.html', 'Book', 'html', 1, 100, 2)",
            [],
        )
        .expect("insert document");
        db.execute(
            "INSERT INTO uploaded_sections (document_id, ordinal, heading, text) \
             VALUES ('doc1', 1, 'Chapter', 'Second block')",
            [],
        )
        .expect("insert second");
        db.execute(
            "INSERT INTO uploaded_sections (document_id, ordinal, heading, text) \
             VALUES ('doc1', 0, 'Intro', 'First block')",
            [],
        )
        .expect("insert first");
        db
    }

    fn test_db_with_empty_document() -> Connection {
        let db = test_schema();
        db.execute(
            "INSERT INTO uploaded_documents \
             (id, url, title, format, imported_at_ms, bytes, sections) \
             VALUES ('empty', '/empty.html', 'Empty', 'html', 1, 0, 0)",
            [],
        )
        .expect("insert empty document");
        db
    }

    fn test_schema() -> Connection {
        let db = Connection::open_in_memory().expect("open test db");
        db.execute_batch(
            "CREATE TABLE uploaded_documents (
               id TEXT PRIMARY KEY,
               url TEXT NOT NULL UNIQUE,
               title TEXT NOT NULL,
               format TEXT NOT NULL,
               imported_at_ms INTEGER NOT NULL,
               bytes INTEGER NOT NULL,
               sections INTEGER NOT NULL
             );
             CREATE TABLE uploaded_sections (
               id INTEGER PRIMARY KEY AUTOINCREMENT,
               document_id TEXT NOT NULL,
               ordinal INTEGER NOT NULL,
               heading TEXT,
               text TEXT NOT NULL
             );",
        )
        .expect("create schema");
        db
    }
}
