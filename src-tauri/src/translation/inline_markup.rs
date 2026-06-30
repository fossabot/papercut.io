//! Inline-markup alignment helpers for translated HTML rendering.
//!
//! Translation engines consume plain text, but reader output needs to preserve
//! author emphasis where it can be placed safely. This module owns the text
//! normalization, source-span collection, fragment-offset matching, and
//! conservative source-to-target span projection used by `render.rs`.

use kuchikiki::NodeRef;

use super::storage::PersistTranslationFragment;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct InlineFormattingSpan {
    pub(crate) start: usize,
    pub(crate) end: usize,
    pub(crate) tags: Vec<String>,
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
/// This is a conservative bridge until true phrase alignment exists. It maps by
/// relative position, snaps to word boundaries, and rejects overlapping output
/// so we do not create visibly misleading nested/stacked emphasis.
pub(crate) fn projected_translated_spans(
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

fn collect_inline_formatting_spans(
    node: &NodeRef,
    active_tags: &mut Vec<String>,
    text: &mut String,
    spans: &mut Vec<InlineFormattingSpan>,
) {
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
        fragment_char_range, projected_translated_spans, source_text_and_inline_formatting_spans,
    };
    use crate::translation::html::parse_html_document;
    use crate::translation::storage::PersistTranslationFragment;

    #[test]
    fn collects_normalized_inline_spans() {
        let document = parse_html_document(
            "<!doctype html><html><body><p>El <em>verso libre</em> es <strong>reaccionario</strong>.</p></body></html>",
        );
        let node = document.select_first("p").expect("paragraph");

        let (text, spans) = source_text_and_inline_formatting_spans(node.as_node());

        assert_eq!(text, "El verso libre es reaccionario.");
        assert_eq!(spans.len(), 2);
        assert_eq!(&text[3..14], "verso libre");
        assert_eq!(spans[0].start, 3);
        assert_eq!(spans[0].end, 14);
        assert_eq!(spans[0].tags, vec!["em"]);
        assert_eq!(spans[1].tags, vec!["strong"]);
    }

    #[test]
    fn prefers_verified_fragment_offsets() {
        let fragment = PersistTranslationFragment {
            source_start: 20,
            source_end: 32,
            source_text: "reactionary.".into(),
            text: "reactionary.".into(),
        };

        let range =
            fragment_char_range("repeat reactionary. reactionary.", &fragment, 0).expect("range");

        assert_eq!(range.0, 20);
        assert_eq!(range.1, 32);
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

        assert!(projected_translated_spans(&spans, 10, "abcdefghij").is_none());
    }
}
