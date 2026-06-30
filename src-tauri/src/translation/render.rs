//! Rendering translated documents.
//!
//! The preferred path clones the sanitized reader HTML and replaces readable
//! block text in document order. That preserves links, images, ids, and EPUB
//! asset rewrites around the text. When a block contains nested anchors/media,
//! we keep the original block intact and insert translated text nearby instead
//! of destroying navigation.

use kuchikiki::NodeRef;

use super::html::parse_html_document;
use super::storage::{PersistTranslationRequest, PersistTranslationSection};

const BLOCK_SELECTOR: &str = "h1,h2,h3,h4,h5,h6,p,li,blockquote";
const PRESERVED_DESCENDANT_SELECTOR: &str = "a,img,table,figure,audio,video";

/// Render a persisted translated document.
///
/// The DOM-preserving path is best-effort by design: if the stored reader HTML
/// cannot be parsed/mapped safely, we fall back to section-only HTML so a
/// completed translation is still viewable, searchable, and durable.
pub(crate) fn render_translated_html(title: &str, request: &PersistTranslationRequest) -> String {
    render_translated_dom(title, request).unwrap_or_else(|| render_section_document(title, request))
}

/// Clone the safe reader HTML and replace readable blocks in source order.
///
/// This keeps EPUB-rewritten image links, footnote anchors, and existing ids in
/// the output. The current mapper follows upload section order, so deeply
/// nested/mixed inline structures are intentionally handled conservatively until
/// a stronger text-node locator layer exists.
fn render_translated_dom(title: &str, request: &PersistTranslationRequest) -> Option<String> {
    if request.source.view_html.trim().is_empty() {
        return None;
    }
    let document = parse_html_document(request.source.view_html.clone());
    update_title(&document, title);
    annotate_article(&document, request);

    let mut sections = request.translated_sections.iter();
    let mut replaced_any = false;
    let mut mapped_sections = 0usize;
    for node in document.select(BLOCK_SELECTOR).ok()? {
        let Some(section) = sections.next() else {
            break;
        };
        mapped_sections += 1;
        annotate_block(node.as_node(), section);
        if section.text.trim().is_empty() {
            continue;
        }
        if has_preserved_descendant(node.as_node()) {
            insert_translation_after(node.as_node(), section);
        } else if replace_text_preserving_full_inline_formatting(
            node.as_node(),
            section.text.trim(),
        ) {
            // The helper already replaced the deepest safe inline wrapper text.
        } else if replace_text_projecting_inline_formatting(node.as_node(), section.text.trim()) {
            // The helper projected safe source emphasis spans onto translated text.
        } else {
            replace_children_with_text(node.as_node(), section.text.trim());
        }
        replaced_any = true;
    }

    if !replaced_any || mapped_sections != request.translated_sections.len() {
        return None;
    }
    serialize_document(&document)
}

/// Build a simple translated document when source DOM preservation is not safe.
///
/// This fallback is deliberately boring HTML: escaped text, stable section ids,
/// source ordinals, and heading metadata. It is less rich visually, but it keeps
/// search and future audiobook generation on the same generated-document path.
fn render_section_document(title: &str, request: &PersistTranslationRequest) -> String {
    let mut body = String::new();
    for section in &request.translated_sections {
        append_section_html(&mut body, section);
    }

    format!(
        "<!doctype html><html><head><meta charset=\"utf-8\"><title>{}</title></head>\
         <body><article data-papercut-translation=\"true\" data-source-document=\"{}\" data-target-language=\"{}\">\
         <h1>{}</h1>{}</article></body></html>",
        escape_html(title),
        escape_html(&request.source.document_url),
        escape_html(&request.target_language),
        escape_html(title),
        body
    )
}

/// Append one translated section to the fallback HTML renderer.
///
/// Heading sections become real heading nodes so the generated document keeps a
/// useful outline even if the original DOM could not be reused.
fn append_section_html(body: &mut String, section: &PersistTranslationSection) {
    let section_id = section_anchor_id(section);
    body.push_str("<section id=\"");
    body.push_str(&section_id);
    body.push_str("\" data-source-ordinal=\"");
    body.push_str(&section.source_ordinal.to_string());
    body.push('"');
    if let Some(heading) = section
        .source_heading
        .as_deref()
        .filter(|heading| !heading.trim().is_empty())
    {
        body.push_str(" data-source-heading=\"");
        body.push_str(&escape_html(heading));
        body.push('"');
    }
    body.push('>');
    if section.is_heading {
        body.push_str("<h2 id=\"");
        body.push_str(&section_id);
        body.push_str("-heading\">");
        body.push_str(&escape_html(section.text.trim()));
        body.push_str("</h2>");
        body.push_str("</section>");
        return;
    }
    for paragraph in section
        .text
        .split('\n')
        .map(str::trim)
        .filter(|paragraph| !paragraph.is_empty())
    {
        body.push_str("<p>");
        body.push_str(&escape_html(paragraph));
        body.push_str("</p>");
    }
    body.push_str("</section>");
}

/// Update the document title when the cloned reader HTML has one.
fn update_title(document: &NodeRef, title: &str) {
    if let Ok(title_node) = document.select_first("title") {
        replace_children_with_text(title_node.as_node(), title);
    }
}

/// Mark the cloned reader root as a generated translation.
///
/// The attributes are useful for future styling/debugging and for distinguishing
/// translated variants from original uploads without needing another DB lookup.
fn annotate_article(document: &NodeRef, request: &PersistTranslationRequest) {
    let article = document
        .select_first("article")
        .ok()
        .or_else(|| document.select_first("body").ok());
    let Some(article) = article else {
        return;
    };
    let mut attrs = article.attributes.borrow_mut();
    attrs.insert("data-papercut-translation", "true".to_string());
    attrs.insert("data-source-document", request.source.document_url.clone());
    attrs.insert("data-target-language", request.target_language.clone());
}

/// Attach source metadata to a translated block.
///
/// Existing ids win because EPUB/HTML links may target them. Missing ids get a
/// stable translation-section id so search results and future readers have an
/// anchor to land on.
fn annotate_block(node: &NodeRef, section: &PersistTranslationSection) {
    let Some(element) = node.as_element() else {
        return;
    };
    let mut attrs = element.attributes.borrow_mut();
    if attrs.get("id").is_none() {
        attrs.insert("id", section_anchor_id(section));
    }
    attrs.insert("data-source-ordinal", section.source_ordinal.to_string());
    if let Some(heading) = section
        .source_heading
        .as_deref()
        .filter(|heading| !heading.trim().is_empty())
    {
        attrs.insert("data-source-heading", heading.to_string());
    }
}

/// Preserve link/media-heavy source blocks by inserting translation nearby.
///
/// Replacing the text inside a paragraph containing anchors can break footnote
/// navigation or lose inline assets. For those blocks, the source block remains
/// intact and the translated text is inserted immediately after it.
fn insert_translation_after(node: &NodeRef, section: &PersistTranslationSection) {
    let tag = if section.is_heading { "h2" } else { "p" };
    let wrapper = parse_html_document(format!(
        "<!doctype html><html><body><{tag} class=\"papercut-translation-inline\" data-source-ordinal=\"{}\">{}</{tag}></body></html>",
        section.source_ordinal,
        escape_html(section.text.trim())
    ));
    let Ok(inserted) = wrapper.select_first(&format!("{tag}.papercut-translation-inline")) else {
        return;
    };
    node.insert_after(inserted.as_node().clone());
}

/// Detect descendants whose behavior/asset references should survive rendering.
fn has_preserved_descendant(node: &NodeRef) -> bool {
    node.select(PRESERVED_DESCENDANT_SELECTOR)
        .ok()
        .and_then(|mut nodes| nodes.next())
        .is_some()
}

/// Preserve whole-block inline emphasis when it is structurally unambiguous.
///
/// MT works on plain text, so we cannot safely place word-level markup after
/// translation without alignment. This narrow path handles the reliable case:
/// one formatting wrapper owns the entire block, for example
/// `<p><em>...</em></p>` or `<p><strong><em>...</em></strong></p>`.
fn replace_text_preserving_full_inline_formatting(node: &NodeRef, text: &str) -> bool {
    let Some(leaf) = full_block_inline_formatting_leaf(node) else {
        return false;
    };
    replace_children_with_text(&leaf, text);
    true
}

fn full_block_inline_formatting_leaf(node: &NodeRef) -> Option<NodeRef> {
    let significant = significant_children(node);
    if significant.len() != 1 || !is_inline_formatting_element(&significant[0]) {
        return None;
    }

    let mut leaf = significant[0].clone();
    if !subtree_is_inline_formatting_only(&leaf) {
        return None;
    }

    loop {
        let children = significant_children(&leaf);
        if children.len() != 1 || !is_inline_formatting_element(&children[0]) {
            break;
        }
        leaf = children[0].clone();
    }

    Some(leaf)
}

fn significant_children(node: &NodeRef) -> Vec<NodeRef> {
    node.children()
        .filter(|child| !is_whitespace_text(child))
        .collect()
}

fn is_whitespace_text(node: &NodeRef) -> bool {
    node.as_text()
        .map(|text| text.borrow().trim().is_empty())
        .unwrap_or(false)
}

fn subtree_is_inline_formatting_only(node: &NodeRef) -> bool {
    if node.as_text().is_some() {
        return true;
    }
    if !is_inline_formatting_element(node) {
        return false;
    }
    node.children()
        .filter(|child| !is_whitespace_text(child))
        .all(|child| subtree_is_inline_formatting_only(&child))
}

fn is_inline_formatting_element(node: &NodeRef) -> bool {
    let Some(element) = node.as_element() else {
        return false;
    };
    matches!(
        element.name.local.as_ref(),
        "b" | "strong" | "i" | "em" | "u" | "s" | "sub" | "sup" | "code" | "mark"
    )
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct InlineFormattingSpan {
    start: usize,
    end: usize,
    tags: Vec<String>,
}

/// Project mixed inline emphasis spans onto translated text.
///
/// This is still conservative: source DOM text nodes give us inline span
/// positions/tag stacks, then we map each span by relative character position
/// snapped to translated word boundaries. If projected spans overlap or cannot
/// land cleanly, we keep the plain-text fallback rather than drawing misleading
/// emphasis.
fn replace_text_projecting_inline_formatting(node: &NodeRef, translated_text: &str) -> bool {
    let (source_text, spans) = source_text_and_inline_formatting_spans(node);
    if source_text.is_empty() || translated_text.trim().is_empty() || spans.is_empty() {
        return false;
    }

    let source_len = source_text.chars().count();
    if source_len == 0
        || spans
            .iter()
            .any(|span| span.start == 0 && span.end >= source_len)
    {
        return false;
    }

    let Some(projected_spans) = projected_translated_spans(&spans, source_len, translated_text)
    else {
        return false;
    };
    if projected_spans.is_empty() {
        return false;
    }

    replace_children_with_projected_formatting(node, translated_text, &projected_spans);
    true
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ProjectedInlineSpan {
    start: usize,
    end: usize,
    tags: Vec<String>,
}

fn source_text_and_inline_formatting_spans(node: &NodeRef) -> (String, Vec<InlineFormattingSpan>) {
    let mut text = String::new();
    let mut spans = Vec::new();
    collect_inline_formatting_spans(node, &mut Vec::new(), &mut text, &mut spans);
    (text, coalesce_inline_spans(spans))
}

fn collect_inline_formatting_spans(
    node: &NodeRef,
    active_tags: &mut Vec<String>,
    text: &mut String,
    spans: &mut Vec<InlineFormattingSpan>,
) {
    if let Some(value) = node.as_text() {
        let start = text.chars().count();
        append_normalized_text(text, &value.borrow());
        let end = text.chars().count();
        if start < end && !active_tags.is_empty() {
            spans.push(InlineFormattingSpan {
                start,
                end,
                tags: active_tags.clone(),
            });
        }
        return;
    }

    let pushed_tag = inline_formatting_tag_name(node);
    if let Some(tag) = pushed_tag.clone() {
        active_tags.push(tag);
    }
    for child in node.children() {
        collect_inline_formatting_spans(&child, active_tags, text, spans);
    }
    if pushed_tag.is_some() {
        active_tags.pop();
    }
}

fn append_normalized_text(output: &mut String, text: &str) {
    for word in text.split_whitespace() {
        if !output.is_empty() {
            output.push(' ');
        }
        output.push_str(word);
    }
}

fn inline_formatting_tag_name(node: &NodeRef) -> Option<String> {
    let element = node.as_element()?;
    let tag = element.name.local.as_ref();
    if matches!(
        tag,
        "b" | "strong" | "i" | "em" | "u" | "s" | "sub" | "sup" | "code" | "mark"
    ) {
        Some(tag.to_string())
    } else {
        None
    }
}

fn coalesce_inline_spans(spans: Vec<InlineFormattingSpan>) -> Vec<InlineFormattingSpan> {
    let mut merged: Vec<InlineFormattingSpan> = Vec::new();
    for span in spans {
        if let Some(previous) = merged.last_mut() {
            if previous.end == span.start && previous.tags == span.tags {
                previous.end = span.end;
                continue;
            }
        }
        merged.push(span);
    }
    merged
}

fn projected_translated_byte_range(
    span: &InlineFormattingSpan,
    source_len: usize,
    translated_text: &str,
) -> Option<(usize, usize)> {
    if source_len == 0 {
        return None;
    }
    let translated_len = translated_text.chars().count();
    if translated_len == 0 {
        return None;
    }

    let start = span.start.saturating_mul(translated_len) / source_len;
    let mut end = span.end.saturating_mul(translated_len).div_ceil(source_len);
    if end <= start {
        end = (start + 1).min(translated_len);
    }
    translated_word_byte_range(translated_text, start, end)
}

fn projected_translated_spans(
    spans: &[InlineFormattingSpan],
    source_len: usize,
    translated_text: &str,
) -> Option<Vec<ProjectedInlineSpan>> {
    let mut projected = Vec::new();
    for span in spans {
        let (start, end) = projected_translated_byte_range(span, source_len, translated_text)?;
        if start >= end {
            return None;
        }
        projected.push(ProjectedInlineSpan {
            start,
            end,
            tags: span.tags.clone(),
        });
    }

    projected.sort_by_key(|span| (span.start, span.end));
    for pair in projected.windows(2) {
        if pair[0].end > pair[1].start {
            return None;
        }
    }

    Some(projected)
}

fn translated_word_byte_range(
    text: &str,
    start_char: usize,
    end_char: usize,
) -> Option<(usize, usize)> {
    let chars = text.char_indices().collect::<Vec<_>>();
    if chars.is_empty() {
        return None;
    }
    let len = chars.len();
    let mut start = start_char.min(len.saturating_sub(1));
    let mut end = end_char.min(len);
    if end <= start {
        end = (start + 1).min(len);
    }

    while start > 0 && is_word_char(chars[start - 1].1) && is_word_char(chars[start].1) {
        start -= 1;
    }
    while end < len && is_word_char(chars[end - 1].1) && is_word_char(chars[end].1) {
        end += 1;
    }

    while start < end && !is_word_char(chars[start].1) {
        start += 1;
    }
    while end > start && !is_word_char(chars[end - 1].1) {
        end -= 1;
    }

    if start >= end {
        return None;
    }
    let byte_start = chars[start].0;
    let byte_end = if end < len { chars[end].0 } else { text.len() };
    Some((byte_start, byte_end))
}

fn is_word_char(ch: char) -> bool {
    ch.is_alphanumeric() || ch == '\'' || ch == '\u{2019}' || ch == '-'
}

fn replace_children_with_projected_formatting(
    node: &NodeRef,
    translated_text: &str,
    spans: &[ProjectedInlineSpan],
) {
    let children = node.children().collect::<Vec<_>>();
    for child in children {
        child.detach();
    }

    let mut cursor = 0usize;
    for span in spans {
        if cursor < span.start {
            node.append(NodeRef::new_text(&translated_text[cursor..span.start]));
        }
        let emphasized = &translated_text[span.start..span.end];
        if let Some(formatted) = formatted_inline_node(&span.tags, emphasized) {
            node.append(formatted);
        } else {
            node.append(NodeRef::new_text(emphasized));
        }
        cursor = span.end;
    }
    if cursor < translated_text.len() {
        node.append(NodeRef::new_text(&translated_text[cursor..]));
    }
}

fn formatted_inline_node(tags: &[String], text: &str) -> Option<NodeRef> {
    let outer = tags.first()?;
    let mut html = String::from("<!doctype html><html><body>");
    for tag in tags {
        html.push('<');
        html.push_str(tag);
        html.push('>');
    }
    html.push_str(&escape_html(text));
    for tag in tags.iter().rev() {
        html.push_str("</");
        html.push_str(tag);
        html.push('>');
    }
    html.push_str("</body></html>");
    let wrapper = parse_html_document(html);
    wrapper
        .select_first(outer.as_str())
        .ok()
        .map(|node| node.as_node().clone())
}

/// Replace all child nodes with one text node.
///
/// This is the plain-text fallback for blocks whose inline formatting is too
/// ambiguous for the current span projection. Richer replacement should
/// wait for exact source-text-node locators.
fn replace_children_with_text(node: &NodeRef, text: &str) {
    let children = node.children().collect::<Vec<_>>();
    for child in children {
        child.detach();
    }
    node.append(NodeRef::new_text(text));
}

/// Serialize the Kuchikiki DOM back into UTF-8 HTML.
fn serialize_document(document: &NodeRef) -> Option<String> {
    let mut bytes = Vec::new();
    document.serialize(&mut bytes).ok()?;
    String::from_utf8(bytes).ok()
}

/// Derive a stable anchor from the original source ordinal.
fn section_anchor_id(section: &PersistTranslationSection) -> String {
    format!("translation-section-{}", section.source_ordinal + 1)
}

/// Escape text for the fallback renderer and generated inline translation nodes.
fn escape_html(value: &str) -> String {
    let mut escaped = String::with_capacity(value.len());
    for ch in value.chars() {
        match ch {
            '&' => escaped.push_str("&amp;"),
            '<' => escaped.push_str("&lt;"),
            '>' => escaped.push_str("&gt;"),
            '"' => escaped.push_str("&quot;"),
            '\'' => escaped.push_str("&#39;"),
            _ => escaped.push(ch),
        }
    }
    escaped
}

#[cfg(test)]
mod tests {
    use super::render_translated_html;
    use crate::translation::source::{TranslationSourceBlock, TranslationSourceDocument};
    use crate::translation::storage::{PersistTranslationRequest, PersistTranslationSection};

    #[test]
    fn preserves_links_when_block_contains_anchor() {
        let request = request(
            "<!doctype html><html><head><title>Source</title></head><body><article><p>See <a href=\"#note\">note</a>.</p><p id=\"note\">Note body.</p></article></body></html>",
            vec![
                section(0, false, "Voir la note."),
                section(1, false, "Corps de la note."),
            ],
        );

        let html = render_translated_html("Translated", &request);

        assert!(html.contains("href=\"#note\""));
        assert!(html.contains("Voir la note."));
        assert!(html.contains("Corps de la note."));
        assert!(html.contains("data-papercut-translation=\"true\""));
    }

    #[test]
    fn replaces_simple_heading_text_in_place() {
        let request = request(
            "<!doctype html><html><head><title>Source</title></head><body><article><h1>Chapitre</h1><p>Bonjour</p></article></body></html>",
            vec![section(0, true, "Chapter"), section(1, false, "Hello")],
        );

        let html = render_translated_html("Translated", &request);

        assert!(html.contains("<h1"));
        assert!(html.contains(">Chapter</h1>"));
        assert!(html.contains("<p"));
        assert!(html.contains(">Hello</p>"));
        assert!(!html.contains(">Chapitre</h1>"));
    }

    #[test]
    fn preserves_whole_block_inline_emphasis() {
        let request = request(
            "<!doctype html><html><body><article><p><strong>Importante.</strong></p><p><em><strong>Muy urgente.</strong></em></p></article></body></html>",
            vec![
                section(0, false, "Important."),
                section(1, false, "Very urgent."),
            ],
        );

        let html = render_translated_html("Translated", &request);

        assert!(html.contains("<strong>Important.</strong>"));
        assert!(html.contains("<em><strong>Very urgent.</strong></em>"));
        assert!(!html.contains("Importante."));
    }

    #[test]
    fn projects_single_partial_inline_emphasis_to_translated_word_boundary() {
        let request = request(
            "<!doctype html><html><body><article><p>Esto es <strong>importante</strong>.</p></article></body></html>",
            vec![section(0, false, "This is important.")],
        );

        let html = render_translated_html("Translated", &request);

        assert!(html.contains(">This is <strong>important</strong>.</p>"));
        assert!(!html.contains("importante"));
    }

    #[test]
    fn projects_multiple_partial_inline_spans_when_ranges_do_not_overlap() {
        let request = request(
            "<!doctype html><html><body><article><p>Esto es <strong>importante</strong> y <em>urgente</em>.</p></article></body></html>",
            vec![section(0, false, "This is important and urgent.")],
        );

        let html = render_translated_html("Translated", &request);

        assert!(html.contains(">This is <strong>important</strong> and <em>urgent</em>.</p>"));
        assert!(!html.contains("importante"));
        assert!(!html.contains("urgente"));
    }

    #[test]
    fn preserves_image_and_table_blocks_by_inserting_translation_nearby() {
        let request = request(
            "<!doctype html><html><body><article><p><img src=\"asset://cover.png\" alt=\"Cover\"> Couverture</p><blockquote><table><tr><td>Nom</td></tr></table></blockquote></article></body></html>",
            vec![
                section(0, false, "Cover image."),
                section(1, false, "Name table."),
            ],
        );

        let html = render_translated_html("Translated", &request);

        assert!(html.contains("src=\"asset://cover.png\""));
        assert!(html.contains("<table>"));
        assert!(html.contains("Cover image."));
        assert!(html.contains("Name table."));
        assert!(html.contains("papercut-translation-inline"));
    }

    #[test]
    fn preserves_rtl_source_links_while_rendering_ltr_translation() {
        let request = request(
            "<!doctype html><html><body><article dir=\"rtl\"><p>انظر <a href=\"#fn1\">١</a></p><p id=\"fn1\">حاشية</p></article></body></html>",
            vec![
                section(0, false, "See note 1."),
                section(1, false, "Footnote body."),
            ],
        );

        let html = render_translated_html("Translated", &request);

        assert!(html.contains("dir=\"rtl\""));
        assert!(html.contains("href=\"#fn1\""));
        assert!(html.contains("id=\"fn1\""));
        assert!(html.contains("See note 1."));
        assert!(html.contains("Footnote body."));
    }

    #[test]
    fn falls_back_when_dom_cannot_map_every_translated_section() {
        let request = request(
            "<!doctype html><html><body><article><h1>Chapitre</h1></article></body></html>",
            vec![section(0, true, "Chapter"), section(1, false, "Hello")],
        );

        let html = render_translated_html("Translated", &request);

        assert!(html.contains("data-papercut-translation=\"true\""));
        assert!(html.contains("Chapter"));
        assert!(html.contains("Hello"));
        assert!(html.contains("translation-section-2"));
    }

    fn request(
        view_html: &str,
        translated_sections: Vec<PersistTranslationSection>,
    ) -> PersistTranslationRequest {
        PersistTranslationRequest {
            source: TranslationSourceDocument {
                document_id: "source1".into(),
                document_url: "/uploads/source1.html".into(),
                title: "Source".into(),
                format: "html".into(),
                view_html: view_html.into(),
                blocks: vec![
                    TranslationSourceBlock {
                        ordinal: 0,
                        heading: Some("Chapitre".into()),
                        text: "Chapitre".into(),
                    },
                    TranslationSourceBlock {
                        ordinal: 1,
                        heading: Some("Chapitre".into()),
                        text: "Bonjour".into(),
                    },
                ],
            },
            source_language: "fr".into(),
            target_language: "en".into(),
            model_id: "opus-mt-fr-en-ctranslate2".into(),
            quality_mode: "balanced".into(),
            repair_mode: Default::default(),
            job_id: "job1".into(),
            glossary: Vec::new(),
            translated_sections,
        }
    }

    fn section(source_ordinal: usize, is_heading: bool, text: &str) -> PersistTranslationSection {
        PersistTranslationSection {
            heading: Some("Chapter".into()),
            source_heading: Some("Chapitre".into()),
            source_ordinal,
            is_heading,
            text: text.into(),
        }
    }
}
