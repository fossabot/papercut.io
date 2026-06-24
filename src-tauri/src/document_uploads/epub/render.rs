//! Rendering helpers for the generated single-file EPUB reader HTML.

/// Wrap one rewritten spine item with a stable chapter anchor and source marker.
pub(super) fn render_chapter(index: usize, path: &str, body: &str) -> String {
    format!(
        "<section class=\"epub-chapter\" id=\"chapter-{index}\" data-source=\"{}\">{body}</section>",
        escape_attr(path),
    )
}

/// Assemble the generated single-file reader HTML stored for this EPUB upload.
///
/// CSS is intentionally minimal and app-owned. EPUB publisher CSS is not reused
/// because it may depend on external assets or layout assumptions we discard.
pub(super) fn render_reading_html(title: &str, chapters: &[String]) -> String {
    let mut html = String::new();
    html.push_str("<!doctype html><html><head><meta charset=\"utf-8\"><title>");
    html.push_str(&escape_html(title));
    html.push_str("</title><style>body{margin:0 auto;max-width:72ch;padding:2rem 1.25rem;line-height:1.65;font-family:serif}img{display:block;max-width:100%;height:auto;margin:1rem auto}.epub-chapter{margin:0 0 2.5rem}</style></head><body>");
    html.push_str("<h1>");
    html.push_str(&escape_html(title));
    html.push_str("</h1>");
    for chapter in chapters {
        html.push_str(chapter);
    }
    html.push_str("</body></html>");
    html
}

pub(super) fn escape_html(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

pub(super) fn escape_attr(value: &str) -> String {
    escape_html(value).replace('\'', "&#39;")
}
