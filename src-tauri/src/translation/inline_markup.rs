//! Inline-markup alignment helpers for translated HTML rendering.
//!
//! Translation engines consume plain text, but reader output needs to preserve
//! author emphasis where it can be placed safely. This module owns the text
//! normalization, source-span collection, fragment-offset matching, and
//! conservative source-to-target span projection used by `render.rs`.

use kuchikiki::NodeRef;

use super::html::parse_html_document;
use super::storage::{PersistTranslationFragment, PersistTranslationInlinePhrase};

const MAX_INLINE_PHRASE_CHARS: usize = 120;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct InlinePhraseProbe {
    pub(crate) source_start: usize,
    pub(crate) source_end: usize,
    pub(crate) text: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct InlineFormattingSpan {
    pub(crate) start: usize,
    pub(crate) end: usize,
    pub(crate) tags: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct InlinePreservedMarker {
    pub(crate) source_offset: usize,
    pub(crate) html: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ProjectedInlineSpan {
    pub(crate) start: usize,
    pub(crate) end: usize,
    pub(crate) tags: Vec<String>,
}

pub(crate) fn is_inline_formatting_element(node: &NodeRef) -> bool {
    let Some(element) = node.as_element() else {
        return false;
    };
    matches!(
        element.name.local.as_ref(),
        "b" | "strong" | "i" | "em" | "u" | "s" | "sub" | "sup" | "code" | "mark"
    )
}

/// Extract normalized source text plus inline formatting ranges.
///
/// The returned text intentionally matches translation segmentation whitespace:
/// all runs collapse to one space. That keeps renderer offsets compatible with
/// `TranslationTextSegment.source_start/source_end` even when source HTML has
/// line breaks or split text nodes inside a paragraph.
pub(crate) fn source_text_and_inline_formatting_spans(
    node: &NodeRef,
) -> (String, Vec<InlineFormattingSpan>) {
    let mut text = String::new();
    let mut spans = Vec::new();
    collect_inline_formatting_spans(node, &mut Vec::new(), &mut text, &mut spans);
    (text, coalesce_inline_spans(spans))
}

/// Extract source block text from reader HTML while skipping reader markers.
///
/// Uploaded section text comes from plain DOM text extraction, so inline
/// footnote anchors can become normal characters such as `topic1`. Translation
/// should see the prose only; marker placement is handled during rendering.
pub(crate) fn source_text_blocks_excluding_nontranslatable_markers(view_html: &str) -> Vec<String> {
    if view_html.trim().is_empty() {
        return Vec::new();
    }
    let document = parse_html_document(view_html.to_string());
    collect_probe_blocks(&document)
        .into_iter()
        .map(|node| source_text_and_inline_formatting_spans(&node).0)
        .collect()
}

/// Collect inline markers with offsets in marker-free normalized source text.
///
/// The translation engine never sees footnote/backlink labels, but the renderer
/// still needs to put their anchors back near the translated phrase they came
/// from. Offsets are measured against the same normalized text contract used by
/// translation fragments.
pub(crate) fn source_text_inline_markers(node: &NodeRef) -> Vec<InlinePreservedMarker> {
    let mut text = String::new();
    let mut markers = Vec::new();
    collect_inline_markers(node, &mut text, &mut markers);
    markers
}

pub(crate) fn is_nontranslatable_inline_marker(node: &NodeRef) -> bool {
    let Some(element) = node.as_element() else {
        return false;
    };
    if element.name.local.as_ref() != "a" {
        return false;
    }
    let attrs = element.attributes.borrow();
    matches!(attrs.get("role"), Some("doc-noteref" | "doc-backlink"))
}

/// Resolve one translated fragment back to the normalized source text.
///
/// Prefer planner-provided char offsets because repeated sentences/phrases can
/// appear in long political texts. If the source DOM diverged from uploaded
/// section text, fall back to search so old/no-offset fragments still render.
pub(crate) fn fragment_char_range(
    source_text: &str,
    fragment: &PersistTranslationFragment,
    search_start: usize,
) -> Option<(usize, usize, usize)> {
    if fragment.source_end > fragment.source_start
        && fragment.source_end <= source_text.chars().count()
        && char_slice(source_text, fragment.source_start, fragment.source_end)
            .is_some_and(|value| value == normalize_fragment_text(&fragment.source_text))
    {
        return Some((
            fragment.source_start,
            fragment.source_end,
            byte_index_for_char(source_text, fragment.source_end),
        ));
    }
    find_fragment_char_range(source_text, &fragment.source_text, search_start)
}

pub(crate) fn local_spans_for_fragment(
    spans: &[InlineFormattingSpan],
    fragment_start: usize,
    fragment_end: usize,
) -> Vec<InlineFormattingSpan> {
    spans
        .iter()
        .filter_map(|span| {
            let start = span.start.max(fragment_start);
            let end = span.end.min(fragment_end);
            (start < end).then(|| InlineFormattingSpan {
                start: start - fragment_start,
                end: end - fragment_start,
                tags: span.tags.clone(),
            })
        })
        .collect()
}

/// Project source formatting ranges onto one translated text window.
///
/// This is a conservative bridge until true phrase alignment exists. It first
/// keeps exact carry-over phrases such as names/titles, then maps remaining
/// ranges by relative position snapped to word boundaries. Overlap rejection is
/// intentional: wrong emphasis is worse than plain translated text.
pub(crate) fn projected_translated_spans(
    spans: &[InlineFormattingSpan],
    source_text: &str,
    translated_text: &str,
    translation_hints: &[PersistTranslationInlinePhrase],
) -> Option<Vec<ProjectedInlineSpan>> {
    let source_len = source_text.chars().count();
    let mut projected = Vec::new();
    for span in spans {
        let projected_span = if let Some(exact) =
            exact_translated_span(span, source_text, translated_text, translation_hints)
        {
            exact
        } else {
            let (start, end) = projected_translated_byte_range(span, source_len, translated_text)?;
            ProjectedInlineSpan {
                start,
                end,
                tags: span.tags.clone(),
            }
        };
        if projected_span.start >= projected_span.end {
            return None;
        }
        projected.push(projected_span);
    }

    projected.sort_by_key(|span| (span.start, span.end));
    for pair in projected.windows(2) {
        if pair[0].end > pair[1].start {
            return None;
        }
    }

    Some(projected)
}

/// Place formatting on an unchanged target phrase when that is unambiguous.
///
/// MT often carries proper nouns, quoted labels, and technical loanwords across
/// unchanged. Matching those exact phrases beats proportional projection for
/// terms like unique project names; requiring one bounded match avoids styling the wrong
/// copy when a phrase repeats.
fn exact_translated_span(
    span: &InlineFormattingSpan,
    source_text: &str,
    translated_text: &str,
    translation_hints: &[PersistTranslationInlinePhrase],
) -> Option<ProjectedInlineSpan> {
    let source_phrase = char_slice(source_text, span.start, span.end)?;
    let phrase = source_phrase.trim();
    if !phrase_is_specific_enough(phrase) {
        return None;
    }
    let hinted_phrase = translation_hints
        .iter()
        .find(|hint| normalize_fragment_text(&hint.source_text) == normalize_fragment_text(phrase))
        .map(|hint| hint.text.trim())
        .filter(|value| !value.is_empty());
    let (start, end) = hinted_phrase
        .and_then(|hint| find_unique_phrase_byte_range(translated_text, hint))
        .or_else(|| find_unique_phrase_byte_range(translated_text, phrase))?;
    Some(ProjectedInlineSpan {
        start,
        end,
        tags: span.tags.clone(),
    })
}

/// Collect emphasized source phrases per readable block for optional repair.
///
/// The job runner can translate these small phrases as probes, then renderer
/// can exact-match the translated phrase. This is cheaper and less risky than
/// inferring cross-language word alignment from whole paragraphs.
pub(crate) fn inline_phrase_probes_by_block(view_html: &str) -> Vec<Vec<InlinePhraseProbe>> {
    if view_html.trim().is_empty() {
        return Vec::new();
    }
    let document = parse_html_document(view_html.to_string());
    collect_probe_blocks(&document)
        .into_iter()
        .map(|node| {
            let (source_text, spans) = source_text_and_inline_formatting_spans(&node);
            spans
                .into_iter()
                .filter_map(|span| inline_phrase_probe(&source_text, span))
                .collect()
        })
        .collect()
}

fn collect_inline_formatting_spans(
    node: &NodeRef,
    active_tags: &mut Vec<String>,
    text: &mut String,
    spans: &mut Vec<InlineFormattingSpan>,
) {
    if is_nontranslatable_inline_marker(node) {
        return;
    }
    if let Some(value) = node.as_text() {
        let appended = append_normalized_text(text, &value.borrow());
        if let Some((start, end)) = appended.filter(|_| !active_tags.is_empty()) {
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

fn collect_inline_markers(
    node: &NodeRef,
    text: &mut String,
    markers: &mut Vec<InlinePreservedMarker>,
) {
    if is_nontranslatable_inline_marker(node) {
        if let Some(html) = serialize_node(node) {
            markers.push(InlinePreservedMarker {
                source_offset: text.chars().count(),
                html,
            });
        }
        return;
    }
    if let Some(value) = node.as_text() {
        append_normalized_text(text, &value.borrow());
        return;
    }
    for child in node.children() {
        collect_inline_markers(&child, text, markers);
    }
}

fn inline_phrase_probe(source_text: &str, span: InlineFormattingSpan) -> Option<InlinePhraseProbe> {
    let text = char_slice(source_text, span.start, span.end)?;
    let text = text.trim();
    if !phrase_is_specific_enough(text) || text.chars().count() > MAX_INLINE_PHRASE_CHARS {
        return None;
    }
    Some(InlinePhraseProbe {
        source_start: span.start,
        source_end: span.end,
        text: text.to_string(),
    })
}

fn collect_probe_blocks(document: &NodeRef) -> Vec<NodeRef> {
    let root = document
        .select_first("body")
        .ok()
        .map(|body| body.as_node().clone())
        .unwrap_or_else(|| document.clone());
    let mut blocks = Vec::new();
    collect_probe_blocks_from(&root, &mut blocks);
    blocks
}

fn collect_probe_blocks_from(node: &NodeRef, blocks: &mut Vec<NodeRef>) {
    for child in node.children() {
        if is_probe_block(&child) {
            blocks.push(child);
        } else {
            collect_probe_blocks_from(&child, blocks);
        }
    }
}

fn is_probe_block(node: &NodeRef) -> bool {
    let Some(element) = node.as_element() else {
        return false;
    };
    matches!(
        element.name.local.as_ref(),
        "h1" | "h2" | "h3" | "h4" | "h5" | "h6" | "p" | "li" | "blockquote"
    )
}

/// Append text using the same whitespace contract as translation segments.
///
/// The returned range excludes any spacer inserted before the first word. That
/// detail matters when a text node is inside `<em>` after unstyled text: the
/// inserted normalizing space should not become emphasized.
fn append_normalized_text(output: &mut String, text: &str) -> Option<(usize, usize)> {
    let mut start = None;
    for word in text.split_whitespace() {
        if !output.is_empty() {
            output.push(' ');
        }
        if start.is_none() {
            start = Some(output.chars().count());
        }
        output.push_str(word);
    }
    start.map(|start| (start, output.chars().count()))
}

fn serialize_node(node: &NodeRef) -> Option<String> {
    let mut bytes = Vec::new();
    node.serialize(&mut bytes).ok()?;
    String::from_utf8(bytes).ok()
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

fn phrase_is_specific_enough(phrase: &str) -> bool {
    phrase.chars().filter(|ch| ch.is_alphanumeric()).count() >= 4
}

fn find_unique_phrase_byte_range(text: &str, phrase: &str) -> Option<(usize, usize)> {
    let mut search_start = 0usize;
    let mut found = None;
    while search_start <= text.len() {
        let Some(relative_start) = text[search_start..].find(phrase) else {
            break;
        };
        let start = search_start + relative_start;
        let end = start + phrase.len();
        if phrase_has_word_boundaries(text, start, end) {
            if found.is_some() {
                return None;
            }
            found = Some((start, end));
        }
        search_start = end;
    }
    found
}

fn phrase_has_word_boundaries(text: &str, start: usize, end: usize) -> bool {
    let first = text[start..].chars().next();
    let last = text[..end].chars().next_back();
    let before = text[..start].chars().next_back();
    let after = text[end..].chars().next();

    let left_ok = !first.is_some_and(is_word_char) || !before.is_some_and(is_word_char);
    let right_ok = !last.is_some_and(is_word_char) || !after.is_some_and(is_word_char);
    left_ok && right_ok
}

/// Snap a projected character range to readable word boundaries.
///
/// Without this, proportional projection often bolds half a word after
/// translation expands/contracts a phrase. The rule is language-light: it uses
/// Unicode alphanumeric characters plus apostrophe/hyphen, which is good enough
/// for the first OPUS-MT MVP and easy to swap for a tokenizer-aware aligner.
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

fn find_fragment_char_range(
    source_text: &str,
    fragment_source_text: &str,
    search_start: usize,
) -> Option<(usize, usize, usize)> {
    let fragment_text = normalize_fragment_text(fragment_source_text);
    if fragment_text.is_empty() || search_start > source_text.len() {
        return None;
    }
    let relative_start = source_text[search_start..].find(&fragment_text)?;
    let byte_start = search_start + relative_start;
    let byte_end = byte_start + fragment_text.len();
    Some((
        source_text[..byte_start].chars().count(),
        source_text[..byte_end].chars().count(),
        byte_end,
    ))
}

fn normalize_fragment_text(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn char_slice(text: &str, start: usize, end: usize) -> Option<String> {
    if start >= end || end > text.chars().count() {
        return None;
    }
    Some(text.chars().skip(start).take(end - start).collect())
}

fn byte_index_for_char(text: &str, char_index: usize) -> usize {
    text.char_indices()
        .nth(char_index)
        .map(|(index, _)| index)
        .unwrap_or(text.len())
}

#[cfg(test)]
mod tests {
    use super::{
        fragment_char_range, inline_phrase_probes_by_block, projected_translated_spans,
        source_text_and_inline_formatting_spans,
        source_text_blocks_excluding_nontranslatable_markers, source_text_inline_markers,
    };
    use crate::translation::html::parse_html_document;
    use crate::translation::storage::{PersistTranslationFragment, PersistTranslationInlinePhrase};

    #[test]
    fn collects_normalized_inline_spans() {
        let document = parse_html_document(
            "<!doctype html><html><body><p>La <em>puerta azul</em> es <strong>importante</strong>.</p></body></html>",
        );
        let node = document.select_first("p").expect("paragraph");

        let (text, spans) = source_text_and_inline_formatting_spans(node.as_node());

        assert_eq!(text, "La puerta azul es importante.");
        assert_eq!(spans.len(), 2);
        assert_eq!(&text[3..14], "puerta azul");
        assert_eq!(spans[0].start, 3);
        assert_eq!(spans[0].end, 14);
        assert_eq!(spans[0].tags, vec!["em"]);
        assert_eq!(spans[1].tags, vec!["strong"]);
    }

    #[test]
    fn prefers_verified_fragment_offsets() {
        let fragment = PersistTranslationFragment {
            source_start: 14,
            source_end: 19,
            source_text: "again".into(),
            text: "again".into(),
            inline_phrases: Vec::new(),
        };

        let range = fragment_char_range("first example again", &fragment, 0).expect("range");

        assert_eq!(range.0, 14);
        assert_eq!(range.1, 19);
    }

    #[test]
    fn rejects_overlapping_projected_spans() {
        let spans = vec![
            super::InlineFormattingSpan {
                start: 0,
                end: 8,
                tags: vec!["strong".into()],
            },
            super::InlineFormattingSpan {
                start: 4,
                end: 10,
                tags: vec!["em".into()],
            },
        ];

        assert!(projected_translated_spans(&spans, "abcdefghij", "abcdefghij", &[]).is_none());
    }

    #[test]
    fn prefers_exact_carryover_for_unique_terms() {
        let spans = vec![super::InlineFormattingSpan {
            start: 12,
            end: 17,
            tags: vec!["em".into(), "strong".into()],
        }];

        let projected =
            projected_translated_spans(&spans, "El proyecto Orion.", "The Orion project.", &[])
                .expect("projected");

        assert_eq!(projected.len(), 1);
        assert_eq!(
            &"The Orion project."[projected[0].start..projected[0].end],
            "Orion"
        );
        assert_eq!(projected[0].tags, vec!["em", "strong"]);
    }

    #[test]
    fn uses_translated_phrase_hint_for_exact_target_match() {
        let spans = vec![super::InlineFormattingSpan {
            start: 3,
            end: 14,
            tags: vec!["strong".into()],
        }];
        let hints = vec![PersistTranslationInlinePhrase {
            source_text: "puerta azul".into(),
            text: "blue door".into(),
        }];

        let projected = projected_translated_spans(
            &spans,
            "La puerta azul abre.",
            "The blue door opens.",
            &hints,
        )
        .expect("projected");

        assert_eq!(
            &"The blue door opens."[projected[0].start..projected[0].end],
            "blue door"
        );
    }

    #[test]
    fn collects_inline_phrase_probes_by_readable_block() {
        let probes = inline_phrase_probes_by_block(
            "<!doctype html><html><body><article><p>La <strong>puerta azul</strong> abre.</p></article></body></html>",
        );

        assert_eq!(probes.len(), 1);
        assert_eq!(probes[0][0].text, "puerta azul");
        assert_eq!(probes[0][0].source_start, 3);
    }

    #[test]
    fn excludes_footnote_markers_from_translation_source_text() {
        let html = "<!doctype html><html><body><article><p>Topic<a href=\"#fn1\" role=\"doc-noteref\"><sup>1</sup></a> changes.</p></article></body></html>";

        let blocks = source_text_blocks_excluding_nontranslatable_markers(html);
        let document = parse_html_document(html);
        let paragraph = document.select_first("p").expect("paragraph");
        let markers = source_text_inline_markers(paragraph.as_node());

        assert_eq!(blocks, vec!["Topic changes."]);
        assert_eq!(markers.len(), 1);
        assert_eq!(markers[0].source_offset, "Topic".chars().count());
        assert!(markers[0].html.contains("role=\"doc-noteref\""));
    }
}
