//! HTML structure extraction: title + ordered readable sections.
//!
//! Deliberately a lightweight, dependency-free scanner (not a full DOM parser).
//! It sanitizes first, then walks block-level tags to build sections, attaching
//! each block to the most recent heading.

use super::sanitize::{decode_entities, normalize_text, sanitize_html, strip_tags};
use super::{ParsedHtmlDocument, ParsedSection};

/// Parse raw HTML into a sanitized document: title, sanitized source, and the
/// ordered sections fed to the FTS index. Each block inherits the current heading.
pub(crate) fn parse_html_document(html: &str) -> ParsedHtmlDocument {
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

/// One extracted block of body text plus whether it came from a heading tag.
struct TextBlock {
    is_heading: bool,
    text: String,
}

/// Scan the body for block-level tags (h1-h6, p, li, blockquote) and return their
/// normalized text in document order; falls back to the whole body if none match.
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

/// Extract and clean the document `<title>`, returning `None` when absent/empty.
fn extract_title(html: &str) -> Option<String> {
    extract_between_case_insensitive(html, "<title", "</title>")
        .and_then(|content| content.find('>').map(|idx| content[idx + 1..].to_string()))
        .map(|title| normalize_text(&decode_entities(&strip_tags(&title))))
        .filter(|title| !title.is_empty())
}

/// Return the inner HTML of `<body>...</body>` (case-insensitive), if present.
fn extract_body(html: &str) -> Option<&str> {
    let lower = html.to_lowercase();
    let body_start = lower.find("<body")?;
    let open_end = lower[body_start..].find('>')? + body_start + 1;
    let body_end = lower[open_end..].find("</body>")? + open_end;
    Some(&html[open_end..body_end])
}

/// Return the slice between the first case-insensitive `open` and `close` markers,
/// indexing back into the original (case-preserving) string.
fn extract_between_case_insensitive<'a>(html: &'a str, open: &str, close: &str) -> Option<&'a str> {
    let lower = html.to_lowercase();
    let start = lower.find(open)?;
    let end = lower[start..].find(close)? + start;
    Some(&html[start..end])
}
