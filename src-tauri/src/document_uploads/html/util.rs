//! Small HTML helpers shared by upload format adapters.

/// Return the inner HTML of `<body>...</body>` (case-insensitive), if present.
///
/// This is intentionally lightweight and operates on already-imported text. EPUB
/// sanitization and HTML section extraction both use it to ignore document heads.
pub(crate) fn extract_body_inner(html: &str) -> Option<&str> {
    let lower = html.to_ascii_lowercase();
    let body_start = lower.find("<body")?;
    let open_end = lower[body_start..].find('>')? + body_start + 1;
    let body_end = lower[open_end..].find("</body>")? + open_end;
    Some(&html[open_end..body_end])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_body_when_unicode_before_tag_expands_under_lowercase() {
        let html = "<html><head>İ</head><BoDy><p>Readable</p></BoDy></html>";
        assert_eq!(extract_body_inner(html), Some("<p>Readable</p>"));
    }
}
