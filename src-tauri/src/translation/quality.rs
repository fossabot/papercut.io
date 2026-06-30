//! First-pass quality gates for completed translation output.
//!
//! These checks are intentionally cheap and deterministic. They do not judge
//! translation quality yet; they only prevent storing obviously broken output
//! such as empty translations or generated HTML with internal links that no
//! longer resolve.

use std::collections::HashSet;

use kuchikiki::{parse_html, traits::TendrilSink, NodeRef};

use super::source::TranslationSourceBlock;
use super::storage::PersistTranslationSection;

const MIN_RATIO_SOURCE_CHARS: usize = 120;
const MIN_TRANSLATED_REPEAT_CHARS: usize = 24;
const MAX_REPEAT_COUNT: usize = 5;
const MIN_LENGTH_RATIO: f32 = 0.05;
const MAX_LENGTH_RATIO: f32 = 8.0;

/// Validate generated translated HTML before it is promoted into reader/search storage.
///
/// This runs after rendering because some problems only exist in final HTML.
/// Keeping it before durable writes avoids indexing variants that users can
/// open but whose footnotes/internal navigation are already known broken.
pub(crate) fn validate_translated_output(
    html: &str,
    source_blocks: &[TranslationSourceBlock],
    sections: &[PersistTranslationSection],
) -> Result<(), String> {
    validate_non_empty_sections(sections)?;
    validate_length_ratios(source_blocks, sections)?;
    validate_repeated_outputs(sections)?;
    let document = parse_html().one(html.to_string());
    validate_internal_links(&document)?;
    Ok(())
}

/// Reject jobs where every translated section is blank.
///
/// Native engines can fail softly by returning empty strings for all segments.
/// That should be reported as a translation failure, not stored as a valid
/// translated document with empty search rows.
fn validate_non_empty_sections(sections: &[PersistTranslationSection]) -> Result<(), String> {
    if sections
        .iter()
        .any(|section| !section.text.trim().is_empty())
    {
        Ok(())
    } else {
        Err("Translation output was empty".into())
    }
}

/// Catch source/translation length mismatches that are almost certainly engine failures.
///
/// This is intentionally loose. Literary and academic translation can expand or
/// compress, especially across scripts. The thresholds only reject output that
/// looks like truncation, decoder loops, or a prompt echo gone very wrong.
fn validate_length_ratios(
    source_blocks: &[TranslationSourceBlock],
    sections: &[PersistTranslationSection],
) -> Result<(), String> {
    for (index, section) in sections.iter().enumerate() {
        let Some(source) = source_block_for_section(source_blocks, section, index) else {
            continue;
        };
        let source_chars = source.text.trim().chars().count();
        let translated_chars = section.text.trim().chars().count();
        if source_chars < MIN_RATIO_SOURCE_CHARS || translated_chars == 0 {
            continue;
        }
        let ratio = translated_chars as f32 / source_chars as f32;
        if !(MIN_LENGTH_RATIO..=MAX_LENGTH_RATIO).contains(&ratio) {
            return Err(format!(
                "Translation output length looks unsafe at source section {}: source {} chars, translated {} chars",
                source.ordinal + 1,
                source_chars,
                translated_chars
            ));
        }
    }
    Ok(())
}

/// Reject repeated long outputs across many sections.
///
/// A common local-model failure mode is returning the same generic sentence for
/// every segment. This does not block repeated short labels/headings; it only
/// catches long repeated bodies that would make a book unusable.
fn validate_repeated_outputs(sections: &[PersistTranslationSection]) -> Result<(), String> {
    let mut counts = std::collections::BTreeMap::<String, usize>::new();
    for section in sections.iter().filter(|section| !section.is_heading) {
        let normalized = normalize_quality_text(&section.text);
        if normalized.chars().count() < MIN_TRANSLATED_REPEAT_CHARS {
            continue;
        }
        let count = counts.entry(normalized.clone()).or_insert(0);
        *count += 1;
        if *count >= MAX_REPEAT_COUNT {
            return Err(format!(
                "Translation output repeats the same long text across {MAX_REPEAT_COUNT} sections: {}",
                truncate_quality_preview(&normalized, 80)
            ));
        }
    }
    Ok(())
}

/// Ensure local `#anchor` links still point at an id in generated HTML.
///
/// This catches the common preservation regression: footnote/table-of-contents
/// links survive as `href="#note"` but the target id is lost during rendering.
/// External links and empty page-top anchors are ignored here.
fn validate_internal_links(document: &NodeRef) -> Result<(), String> {
    let ids = document
        .select("[id]")
        .map_err(|_| "Failed to inspect translated HTML ids".to_string())?
        .filter_map(|node| {
            node.attributes
                .borrow()
                .get("id")
                .map(|value| value.trim().to_string())
        })
        .filter(|value| !value.is_empty())
        .collect::<HashSet<_>>();

    let mut missing = Vec::new();
    for node in document
        .select("a[href]")
        .map_err(|_| "Failed to inspect translated HTML links".to_string())?
    {
        let href = node
            .attributes
            .borrow()
            .get("href")
            .map(|value| value.trim().to_string());
        let Some(href) = href else {
            continue;
        };
        let Some(target) = href.strip_prefix('#') else {
            continue;
        };
        if target.is_empty() {
            continue;
        }
        if !ids.contains(target) {
            missing.push(href);
        }
    }

    if missing.is_empty() {
        Ok(())
    } else {
        Err(format!(
            "Translation output has broken internal link target(s): {}",
            missing.join(", ")
        ))
    }
}

fn source_block_for_section<'a>(
    source_blocks: &'a [TranslationSourceBlock],
    section: &PersistTranslationSection,
    fallback_index: usize,
) -> Option<&'a TranslationSourceBlock> {
    source_blocks
        .iter()
        .find(|block| block.ordinal == section.source_ordinal)
        .or_else(|| source_blocks.get(fallback_index))
}

fn normalize_quality_text(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn truncate_quality_preview(text: &str, max_chars: usize) -> String {
    let mut chars = text.chars();
    let preview = chars.by_ref().take(max_chars).collect::<String>();
    if chars.next().is_some() {
        format!("{preview}...")
    } else {
        preview
    }
}

#[cfg(test)]
mod tests {
    use super::validate_translated_output;
    use crate::translation::source::TranslationSourceBlock;
    use crate::translation::storage::PersistTranslationSection;

    #[test]
    fn accepts_internal_links_with_targets() {
        validate_translated_output(
            "<article><p><a href=\"#note-1\">note</a></p><p id=\"note-1\">body</p></article>",
            &[source_block(0, "Source text")],
            &[section("Translated text")],
        )
        .expect("valid links");
    }

    #[test]
    fn rejects_missing_internal_link_targets() {
        let error = validate_translated_output(
            "<article><p><a href=\"#missing\">note</a></p></article>",
            &[source_block(0, "Source text")],
            &[section("Translated text")],
        )
        .expect_err("broken target");

        assert!(error.contains("#missing"));
    }

    #[test]
    fn rejects_empty_translated_sections() {
        let error = validate_translated_output(
            "<article></article>",
            &[source_block(0, "Source text")],
            &[section("   ")],
        )
        .expect_err("empty translation");

        assert!(error.contains("empty"));
    }

    #[test]
    fn rejects_extreme_length_ratio() {
        let source = "Long source text. ".repeat(20);
        let error = validate_translated_output(
            "<article><p>tiny</p></article>",
            &[source_block(0, &source)],
            &[section("tiny")],
        )
        .expect_err("unsafe length");

        assert!(error.contains("length"));
    }

    #[test]
    fn rejects_repeated_long_outputs() {
        let repeated = "This is the same suspicious translation body.";
        let sources = (0..5)
            .map(|index| source_block(index, "Different source paragraph with enough text."))
            .collect::<Vec<_>>();
        let sections = (0..5).map(|_| section(repeated)).collect::<Vec<_>>();

        let error = validate_translated_output("<article></article>", &sources, &sections)
            .expect_err("repeated output");

        assert!(error.contains("repeats"));
    }

    fn section(text: &str) -> PersistTranslationSection {
        PersistTranslationSection {
            heading: None,
            source_heading: None,
            source_ordinal: 0,
            is_heading: false,
            text: text.into(),
        }
    }

    fn source_block(ordinal: usize, text: &str) -> TranslationSourceBlock {
        TranslationSourceBlock {
            ordinal,
            heading: None,
            text: text.into(),
        }
    }
}
