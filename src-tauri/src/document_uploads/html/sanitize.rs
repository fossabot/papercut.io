//! Conservative HTML sanitization and text normalization.
//!
//! A first-pass, dependency-free sanitizer: it strips active elements, drops
//! risky attributes, and provides the tag-stripping / entity-decoding / whitespace
//! helpers the parser reuses. Not a full standards-compliant sanitizer.

/// Strip active/risky elements and unsafe attributes, returning storable HTML.
pub(crate) fn sanitize_html(html: &str) -> String {
    let without_active = strip_element(html, "script");
    let without_active = strip_element(&without_active, "style");
    let without_active = strip_element(&without_active, "iframe");
    let without_active = strip_element(&without_active, "object");
    let without_active = strip_element(&without_active, "embed");
    sanitize_tag_attributes(&without_active)
}

/// Remove every `<tag>...</tag>` region (case-insensitive) for the named element;
/// drops to end-of-input if a closing tag is missing.
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

/// Walk every tag and rewrite it through [`sanitize_single_tag`], passing through
/// the non-tag text between them unchanged.
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

/// Sanitize one tag's inner text: keep closing/doctype/PI tags as-is, otherwise
/// drop `on*`, `style`, `src`, and `javascript:` href attributes.
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

/// Strip all tags to plain text (each `>` becomes a space) and decode entities.
pub(crate) fn strip_tags(html: &str) -> String {
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

/// Decode the small set of HTML entities that appear in extracted text.
pub(crate) fn decode_entities(text: &str) -> String {
    text.replace("&nbsp;", " ")
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
}

/// Collapse all runs of whitespace into single spaces and trim the result.
pub(crate) fn normalize_text(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}
