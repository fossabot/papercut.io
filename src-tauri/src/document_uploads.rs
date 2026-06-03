use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::collections::hash_map::DefaultHasher;
use std::fs;
use std::hash::{Hash, Hasher};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{Manager, Runtime};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_fs::FsExt;

const UPLOAD_URL_PREFIX: &str = "/uploads/";
const MAX_UPLOAD_BYTES: u64 = 25 * 1024 * 1024;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UploadedDocument {
    id: String,
    url: String,
    title: String,
    format: String,
    imported_at_ms: u128,
    bytes: u64,
    sections: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UploadedDocumentSearchResult {
    id: String,
    document_id: String,
    url: String,
    title: String,
    excerpt: String,
    section_title: Option<String>,
    section_index: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UploadedDocumentDeleteResult {
    id: String,
    url: String,
    bytes_freed: u64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UploadedDocumentSourceRequest {
    document_url: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UploadedDocumentSearchRequest {
    query: String,
    limit: Option<usize>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UploadedDocumentDeleteRequest {
    document_url: String,
}

struct ParsedHtmlDocument {
    title: String,
    sanitized_html: String,
    sections: Vec<ParsedSection>,
}

struct ParsedSection {
    heading: Option<String>,
    text: String,
}

#[tauri::command]
pub async fn document_uploads_import_html<R: Runtime>(
    app: tauri::AppHandle<R>,
) -> Result<UploadedDocument, String> {
    tauri::async_runtime::spawn_blocking(move || import_html(app))
        .await
        .map_err(|err| format!("Document import task failed: {err}"))?
}

#[tauri::command]
pub async fn document_uploads_list<R: Runtime>(
    app: tauri::AppHandle<R>,
) -> Result<Vec<UploadedDocument>, String> {
    tauri::async_runtime::spawn_blocking(move || list_uploads(&app))
        .await
        .map_err(|err| format!("Document upload list task failed: {err}"))?
}

#[tauri::command]
pub async fn document_uploads_search<R: Runtime>(
    app: tauri::AppHandle<R>,
    request: UploadedDocumentSearchRequest,
) -> Result<Vec<UploadedDocumentSearchResult>, String> {
    tauri::async_runtime::spawn_blocking(move || search_uploads(&app, request))
        .await
        .map_err(|err| format!("Document upload search task failed: {err}"))?
}

#[tauri::command]
pub async fn document_uploads_get_source<R: Runtime>(
    app: tauri::AppHandle<R>,
    request: UploadedDocumentSourceRequest,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || get_source(&app, request))
        .await
        .map_err(|err| format!("Document upload source task failed: {err}"))?
}

#[tauri::command]
pub async fn document_uploads_delete<R: Runtime>(
    app: tauri::AppHandle<R>,
    request: UploadedDocumentDeleteRequest,
) -> Result<UploadedDocumentDeleteResult, String> {
    tauri::async_runtime::spawn_blocking(move || delete_upload(&app, request))
        .await
        .map_err(|err| format!("Document upload delete task failed: {err}"))?
}

fn import_html<R: Runtime>(app: tauri::AppHandle<R>) -> Result<UploadedDocument, String> {
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

fn list_uploads<R: Runtime>(app: &tauri::AppHandle<R>) -> Result<Vec<UploadedDocument>, String> {
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

fn search_uploads<R: Runtime>(
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

fn get_source<R: Runtime>(
    app: &tauri::AppHandle<R>,
    request: UploadedDocumentSourceRequest,
) -> Result<String, String> {
    let id = upload_id_from_url(&request.document_url)?;
    let path = upload_dir(app, &id)?.join("source.html");
    fs::read_to_string(&path)
        .map_err(|err| format!("Failed to read uploaded document {}: {err}", path.display()))
}

fn delete_upload<R: Runtime>(
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

fn open_db<R: Runtime>(app: &tauri::AppHandle<R>) -> Result<Connection, String> {
    let root = uploads_root(app)?;
    fs::create_dir_all(&root)
        .map_err(|err| format!("Failed to create upload storage {}: {err}", root.display()))?;
    let db = Connection::open(root.join("search.sqlite3")).map_err(db_err)?;
    db.execute_batch(
        "PRAGMA journal_mode = WAL;
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

fn delete_document_rows(db: &mut Connection, id: &str) -> Result<(), String> {
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

fn upsert_document(
    db: &mut Connection,
    id: &str,
    url: &str,
    parsed: &ParsedHtmlDocument,
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
         VALUES (?1, ?2, ?3, 'html', ?4, ?5, ?6)",
        params![
            id,
            url,
            parsed.title,
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

fn parse_html_document(html: &str) -> ParsedHtmlDocument {
    let sanitized = sanitize_html(html);
    let title = extract_title(&sanitized).unwrap_or_else(|| "Imported HTML Document".into());
    let blocks = extract_text_blocks(&sanitized);
    let mut sections = Vec::new();
    let mut current_heading: Option<String> = None;

    for block in blocks {
        if block.is_heading {
            current_heading = Some(block.text.clone());
            sections.push(ParsedSection {
                heading: current_heading.clone(),
                text: block.text,
            });
        } else if !block.text.is_empty() {
            sections.push(ParsedSection {
                heading: current_heading.clone(),
                text: block.text,
            });
        }
    }

    ParsedHtmlDocument {
        title,
        sanitized_html: sanitized,
        sections,
    }
}

struct TextBlock {
    is_heading: bool,
    text: String,
}

fn extract_text_blocks(html: &str) -> Vec<TextBlock> {
    let body = extract_body(html).unwrap_or(html);
    let mut blocks = Vec::new();
    let mut pos = 0usize;
    let lower = body.to_lowercase();

    while let Some(start_rel) = lower[pos..].find('<') {
        let start = pos + start_rel;
        let Some(end_rel) = lower[start..].find('>') else {
            break;
        };
        let end = start + end_rel + 1;
        let tag = lower[start + 1..end - 1].trim().to_string();
        let tag_name = tag
            .trim_start_matches('/')
            .split_whitespace()
            .next()
            .unwrap_or("");
        let is_target = matches!(
            tag_name,
            "h1" | "h2" | "h3" | "h4" | "h5" | "h6" | "p" | "li" | "blockquote"
        );
        if is_target && !tag.starts_with('/') {
            let close = format!("</{tag_name}>");
            if let Some(close_rel) = lower[end..].find(&close) {
                let content_end = end + close_rel;
                let text = normalize_text(&strip_tags(&body[end..content_end]));
                if !text.is_empty() {
                    blocks.push(TextBlock {
                        is_heading: tag_name.starts_with('h'),
                        text,
                    });
                }
                pos = content_end + close.len();
                continue;
            }
        }
        pos = end;
    }

    if blocks.is_empty() {
        let text = normalize_text(&strip_tags(body));
        if !text.is_empty() {
            blocks.push(TextBlock {
                is_heading: false,
                text,
            });
        }
    }

    blocks
}

fn sanitize_html(html: &str) -> String {
    let without_active = strip_element(html, "script");
    let without_active = strip_element(&without_active, "style");
    let without_active = strip_element(&without_active, "iframe");
    let without_active = strip_element(&without_active, "object");
    let without_active = strip_element(&without_active, "embed");
    sanitize_tag_attributes(&without_active)
}

fn strip_element(html: &str, tag: &str) -> String {
    let mut out = String::with_capacity(html.len());
    let lower = html.to_lowercase();
    let open_prefix = format!("<{tag}");
    let close = format!("</{tag}>");
    let mut pos = 0usize;

    while let Some(start_rel) = lower[pos..].find(&open_prefix) {
        let start = pos + start_rel;
        out.push_str(&html[pos..start]);
        if let Some(close_rel) = lower[start..].find(&close) {
            pos = start + close_rel + close.len();
        } else {
            pos = html.len();
            break;
        }
    }
    out.push_str(&html[pos..]);
    out
}

fn sanitize_tag_attributes(html: &str) -> String {
    let mut out = String::with_capacity(html.len());
    let mut pos = 0usize;

    while let Some(start_rel) = html[pos..].find('<') {
        let start = pos + start_rel;
        out.push_str(&html[pos..start]);
        let Some(end_rel) = html[start..].find('>') else {
            out.push_str(&html[start..]);
            return out;
        };
        let end = start + end_rel;
        let tag = &html[start + 1..end];
        out.push('<');
        out.push_str(&sanitize_single_tag(tag));
        out.push('>');
        pos = end + 1;
    }
    out.push_str(&html[pos..]);
    out
}

fn sanitize_single_tag(tag: &str) -> String {
    let trimmed = tag.trim();
    if trimmed.starts_with('/') || trimmed.starts_with('!') || trimmed.starts_with('?') {
        return trimmed.to_string();
    }

    let self_closing = trimmed.ends_with('/');
    let inner = trimmed.trim_end_matches('/').trim();
    let mut parts = inner.split_whitespace();
    let Some(name) = parts.next() else {
        return String::new();
    };
    let mut safe = String::from(name);
    for attr in parts {
        let lower = attr.to_lowercase();
        if lower.starts_with("on") || lower.starts_with("style") || lower.starts_with("src=") {
            continue;
        }
        if lower.starts_with("href=") && lower.contains("javascript:") {
            continue;
        }
        safe.push(' ');
        safe.push_str(attr);
    }
    if self_closing {
        safe.push_str(" /");
    }
    safe
}

fn extract_title(html: &str) -> Option<String> {
    extract_between_case_insensitive(html, "<title", "</title>")
        .and_then(|content| content.find('>').map(|idx| content[idx + 1..].to_string()))
        .map(|title| normalize_text(&decode_entities(&strip_tags(&title))))
        .filter(|title| !title.is_empty())
}

fn extract_body(html: &str) -> Option<&str> {
    let lower = html.to_lowercase();
    let body_start = lower.find("<body")?;
    let open_end = lower[body_start..].find('>')? + body_start + 1;
    let body_end = lower[open_end..].find("</body>")? + open_end;
    Some(&html[open_end..body_end])
}

fn extract_between_case_insensitive<'a>(html: &'a str, open: &str, close: &str) -> Option<&'a str> {
    let lower = html.to_lowercase();
    let start = lower.find(open)?;
    let end = lower[start..].find(close)? + start;
    Some(&html[start..end])
}

fn strip_tags(html: &str) -> String {
    let mut out = String::with_capacity(html.len());
    let mut in_tag = false;
    for ch in html.chars() {
        match ch {
            '<' => in_tag = true,
            '>' => {
                in_tag = false;
                out.push(' ');
            }
            _ if !in_tag => out.push(ch),
            _ => {}
        }
    }
    decode_entities(&out)
}

fn decode_entities(text: &str) -> String {
    text.replace("&nbsp;", " ")
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
}

fn normalize_text(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn fts_query(query: &str) -> String {
    query
        .split(|ch: char| !ch.is_alphanumeric() && ch != '_')
        .filter(|part| !part.is_empty())
        .take(12)
        .map(|term| format!("\"{}\"", term.replace('"', "")))
        .collect::<Vec<_>>()
        .join(" AND ")
}

fn upload_id(title: &str, sections: &[ParsedSection], imported_at_ms: u128) -> String {
    let mut hasher = DefaultHasher::new();
    title.hash(&mut hasher);
    imported_at_ms.hash(&mut hasher);
    for section in sections.iter().take(16) {
        section.text.hash(&mut hasher);
    }
    format!("{:016x}", hasher.finish())
}

fn upload_id_from_url(url: &str) -> Result<String, String> {
    let path = url.split(['?', '#']).next().unwrap_or(url);
    let Some(rest) = path.strip_prefix(UPLOAD_URL_PREFIX) else {
        return Err("Document is not a generic uploaded document".into());
    };
    let Some(id) = rest.strip_suffix(".html") else {
        return Err("Uploaded document URL must end in .html".into());
    };
    if id.is_empty() || !id.chars().all(|ch| ch.is_ascii_hexdigit()) {
        return Err("Uploaded document id is invalid".into());
    }
    Ok(id.to_string())
}

fn uploads_root<R: Runtime>(app: &tauri::AppHandle<R>) -> Result<PathBuf, String> {
    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|err| format!("Failed to resolve app data dir for document uploads: {err}"))?;
    Ok(app_data.join("document_uploads"))
}

fn upload_dir<R: Runtime>(app: &tauri::AppHandle<R>, id: &str) -> Result<PathBuf, String> {
    Ok(uploads_root(app)?.join(id))
}

fn directory_size(path: &Path) -> Result<u64, String> {
    if !path.exists() {
        return Ok(0);
    }
    let metadata = fs::metadata(path).map_err(|err| {
        format!(
            "Failed to inspect uploaded document storage {}: {err}",
            path.display()
        )
    })?;
    if metadata.is_file() {
        return Ok(metadata.len());
    }

    let mut total = 0;
    for entry in fs::read_dir(path).map_err(|err| {
        format!(
            "Failed to read uploaded document storage {}: {err}",
            path.display()
        )
    })? {
        let entry =
            entry.map_err(|err| format!("Failed to inspect uploaded document file: {err}"))?;
        total += directory_size(&entry.path())?;
    }
    Ok(total)
}

fn now_ms() -> Result<u128, String> {
    Ok(SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|err| format!("System clock error: {err}"))?
        .as_millis())
}

fn db_err(err: rusqlite::Error) -> String {
    format!("Document upload database error: {err}")
}
