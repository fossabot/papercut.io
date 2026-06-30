//! Rendering translated documents.
//!
//! The preferred path clones the sanitized reader HTML and replaces readable
//! block text in document order. That preserves links, images, ids, and EPUB
//! asset rewrites around the text. When a block contains nested anchors/media,
//! we keep the original block intact and insert translated text nearby instead
//! of destroying navigation.

use kuchikiki::{parse_html, traits::TendrilSink, NodeRef};

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
    let document = parse_html().one(request.source.view_html.clone());
    update_title(&document, title);
    annotate_article(&document, request);

    let mut sections = request.translated_sections.iter();
    let mut replaced_any = false;
    for node in document.select(BLOCK_SELECTOR).ok()? {
        let Some(section) = sections.next() else {
            break;
        };
        annotate_block(node.as_node(), section);
        if section.text.trim().is_empty() {
            continue;
        }
        if has_preserved_descendant(node.as_node()) {
            insert_translation_after(node.as_node(), section);
        } else {
            replace_children_with_text(node.as_node(), section.text.trim());
        }
        replaced_any = true;
    }

    if !replaced_any {
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
    let wrapper = parse_html().one(format!(
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

/// Replace all child nodes with one text node.
///
/// This intentionally drops simple inline formatting for now. The tradeoff is
/// safe escaped text with predictable mapping; richer inline replacement should
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
            job_id: "job1".into(),
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
