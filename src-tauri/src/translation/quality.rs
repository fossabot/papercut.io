//! First-pass quality gates for completed translation output.
//!
//! These checks are intentionally cheap and deterministic. They do not judge
//! translation quality yet; they only prevent storing obviously broken output
//! such as empty translations or generated HTML with internal links that no
//! longer resolve.

use std::collections::HashSet;

use kuchikiki::NodeRef;

use super::html::parse_html_document;
use super::source::TranslationSourceBlock;
use super::storage::PersistTranslationSection;
use super::types::TranslationGlossaryEntry;

const MIN_RATIO_SOURCE_CHARS: usize = 120;
const MIN_TRANSLATED_REPEAT_CHARS: usize = 24;
const MAX_REPEAT_COUNT: usize = 5;
const MIN_LENGTH_RATIO: f32 = 0.05;
const MAX_LENGTH_RATIO: f32 = 8.0;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct TranslationQualityIssue {
    pub(crate) kind: TranslationQualityIssueKind,
    pub(crate) source_ordinal: Option<usize>,
    pub(crate) message: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum TranslationQualityIssueKind {
    EmptyOutput,
    SectionCoverage,
    LengthRatio,
    RepeatedOutput,
    GlossaryTarget,
    BrokenInternalLink,
}

impl TranslationQualityIssue {
    fn new(
        kind: TranslationQualityIssueKind,
        source_ordinal: Option<usize>,
        message: impl Into<String>,
    ) -> Self {
        Self {
            kind,
            source_ordinal,
            message: message.into(),
        }
    }

    fn to_user_message(&self) -> String {
        match self.source_ordinal {
            Some(ordinal) => format!("source section {}: {}", ordinal + 1, self.message),
            None => self.message.clone(),
        }
    }
}

/// Validate generated translated HTML before it is promoted into reader/search storage.
///
/// This runs after rendering because some problems only exist in final HTML.
/// Keeping it before durable writes avoids indexing variants that users can
/// open but whose footnotes/internal navigation are already known broken.
pub(crate) fn validate_translated_output(
    html: &str,
    source_blocks: &[TranslationSourceBlock],
    sections: &[PersistTranslationSection],
    glossary: &[TranslationGlossaryEntry],
) -> Result<(), String> {
    validate_non_empty_sections(sections).map_err(format_quality_issue)?;
    validate_section_coverage(source_blocks, sections).map_err(format_quality_issue)?;
    validate_length_ratios(source_blocks, sections).map_err(format_quality_issue)?;
    validate_repeated_outputs(sections).map_err(format_quality_issue)?;
    validate_glossary_terms(source_blocks, sections, glossary).map_err(format_quality_issue)?;
    let document = parse_html_document(html);
    validate_internal_links(&document).map_err(format_quality_issue)?;
    Ok(())
}

/// Reject jobs where every translated section is blank.
///
/// Native engines can fail softly by returning empty strings for all segments.
/// That should be reported as a translation failure, not stored as a valid
/// translated document with empty search rows.
fn validate_non_empty_sections(
    sections: &[PersistTranslationSection],
) -> Result<(), TranslationQualityIssue> {
    if sections
        .iter()
        .any(|section| !section.text.trim().is_empty())
    {
        Ok(())
    } else {
        Err(TranslationQualityIssue::new(
            TranslationQualityIssueKind::EmptyOutput,
            None,
            "Translation output was empty",
        ))
    }
}

/// Reject partial jobs before storage promotes them into normal documents.
///
/// Segment caches can prove the engine translated many individual chunks, but
/// the durable reader/search document must have one output section for every
/// source block. Otherwise failures like "only the title translated" look like
/// successful jobs and become harder to diagnose after import.
fn validate_section_coverage(
    source_blocks: &[TranslationSourceBlock],
    sections: &[PersistTranslationSection],
) -> Result<(), TranslationQualityIssue> {
    if sections.len() == source_blocks.len() {
        return Ok(());
    }
    Err(TranslationQualityIssue::new(
        TranslationQualityIssueKind::SectionCoverage,
        None,
        format!(
            "Translation output is incomplete: {} source section(s), {} translated section(s)",
            source_blocks.len(),
            sections.len()
        ),
    ))
}

/// Catch source/translation length mismatches that are almost certainly engine failures.
///
/// This is intentionally loose. Literary and academic translation can expand or
/// compress, especially across scripts. The thresholds only reject output that
/// looks like truncation, decoder loops, or a prompt echo gone very wrong.
fn validate_length_ratios(
    source_blocks: &[TranslationSourceBlock],
    sections: &[PersistTranslationSection],
) -> Result<(), TranslationQualityIssue> {
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
            return Err(TranslationQualityIssue::new(
                TranslationQualityIssueKind::LengthRatio,
                Some(source.ordinal),
                format!(
                    "Translation output length looks unsafe: source {} chars, translated {} chars",
                    source_chars, translated_chars
                ),
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
fn validate_repeated_outputs(
    sections: &[PersistTranslationSection],
) -> Result<(), TranslationQualityIssue> {
    let mut counts = std::collections::BTreeMap::<String, (usize, usize)>::new();
    for section in sections.iter().filter(|section| !section.is_heading) {
        let normalized = normalize_quality_text(&section.text);
        if normalized.chars().count() < MIN_TRANSLATED_REPEAT_CHARS {
            continue;
        }
        let (count, first_ordinal) = counts
            .entry(normalized.clone())
            .or_insert((0, section.source_ordinal));
        *count += 1;
        if *count >= MAX_REPEAT_COUNT {
            return Err(TranslationQualityIssue::new(
                TranslationQualityIssueKind::RepeatedOutput,
                Some(*first_ordinal),
                format!(
                    "Translation output repeats the same long text across {MAX_REPEAT_COUNT} sections: {}",
                    truncate_quality_preview(&normalized, 80)
                ),
            ));
        }
    }
    Ok(())
}

/// Ensure protected glossary terms survive in translated output.
///
/// Glossary entries are user instructions, not soft hints. If the source section
/// contains the source term and the translated section does not contain the
/// requested target term, storing the variant would make the glossary look
/// successful while silently ignoring it.
fn validate_glossary_terms(
    source_blocks: &[TranslationSourceBlock],
    sections: &[PersistTranslationSection],
    glossary: &[TranslationGlossaryEntry],
) -> Result<(), TranslationQualityIssue> {
    if glossary.is_empty() {
        return Ok(());
    }
    for (index, section) in sections.iter().enumerate() {
        let Some(source) = source_block_for_section(source_blocks, section, index) else {
            continue;
        };
        for entry in glossary {
            if contains_case_insensitive(&source.text, &entry.source)
                && !contains_case_insensitive(&section.text, &entry.target)
            {
                return Err(TranslationQualityIssue::new(
                    TranslationQualityIssueKind::GlossaryTarget,
                    Some(source.ordinal),
                    format!(
                        "Translation output missed glossary target {:?} for source term {:?}",
                        entry.target.trim(),
                        entry.source.trim()
                    ),
                ));
            }
        }
    }
    Ok(())
}

/// Ensure local `#anchor` links still point at an id in generated HTML.
///
/// This catches the common preservation regression: footnote/table-of-contents
/// links survive as `href="#note"` but the target id is lost during rendering.
/// External links and empty page-top anchors are ignored here.
fn validate_internal_links(document: &NodeRef) -> Result<(), TranslationQualityIssue> {
    let ids = document
        .select("[id]")
        .map_err(|_| {
            TranslationQualityIssue::new(
                TranslationQualityIssueKind::BrokenInternalLink,
                None,
                "Failed to inspect translated HTML ids",
            )
        })?
        .filter_map(|node| {
            node.attributes
                .borrow()
                .get("id")
                .map(|value| value.trim().to_string())
        })
        .filter(|value| !value.is_empty())
        .collect::<HashSet<_>>();

    let mut missing = Vec::new();
    for node in document.select("a[href]").map_err(|_| {
        TranslationQualityIssue::new(
            TranslationQualityIssueKind::BrokenInternalLink,
            None,
            "Failed to inspect translated HTML links",
        )
    })? {
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
        Err(TranslationQualityIssue::new(
            TranslationQualityIssueKind::BrokenInternalLink,
            None,
            format!(
                "Translation output has broken internal link target(s): {}",
                missing.join(", ")
            ),
        ))
    }
}

fn format_quality_issue(issue: TranslationQualityIssue) -> String {
    issue.to_user_message()
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

fn contains_case_insensitive(text: &str, needle: &str) -> bool {
    let needle = needle.trim();
    if needle.is_empty() {
        return false;
    }
    text.to_lowercase().contains(&needle.to_lowercase())
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
    use crate::translation::types::TranslationGlossaryEntry;

    #[test]
    fn accepts_internal_links_with_targets() {
        validate_translated_output(
            "<article><p><a href=\"#note-1\">note</a></p><p id=\"note-1\">body</p></article>",
            &[source_block(0, "Source text")],
            &[section("Translated text")],
            &[],
        )
        .expect("valid links");
    }

    #[test]
    fn rejects_missing_internal_link_targets() {
        let error = validate_translated_output(
            "<article><p><a href=\"#missing\">note</a></p></article>",
            &[source_block(0, "Source text")],
            &[section("Translated text")],
            &[],
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
            &[],
        )
        .expect_err("empty translation");

        assert!(error.contains("empty"));
    }

    #[test]
    fn rejects_incomplete_section_coverage() {
        let error = validate_translated_output(
            "<article><h1>Title</h1></article>",
            &[source_block(0, "Title"), source_block(1, "Body text")],
            &[section("Title")],
            &[],
        )
        .expect_err("missing translated body");

        assert!(error.contains("incomplete"));
        assert!(error.contains("2 source section"));
    }

    #[test]
    fn rejects_extreme_length_ratio() {
        let source = "Long source text. ".repeat(20);
        let error = validate_translated_output(
            "<article><p>tiny</p></article>",
            &[source_block(0, &source)],
            &[section("tiny")],
            &[],
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

        let error = validate_translated_output("<article></article>", &sources, &sections, &[])
            .expect_err("repeated output");

        assert!(error.contains("repeats"));
    }

    #[test]
    fn accepts_glossary_target_when_source_term_is_present() {
        validate_translated_output(
            "<article><p>State and Revolution</p></article>",
            &[source_block(0, "Estado y revolucion")],
            &[section("State and Revolution")],
            &[glossary("Estado", "State")],
        )
        .expect("glossary target present");
    }

    #[test]
    fn rejects_missing_glossary_target() {
        let error = validate_translated_output(
            "<article><p>Government and Revolution</p></article>",
            &[source_block(0, "Estado y revolucion")],
            &[section("Government and Revolution")],
            &[glossary("Estado", "State")],
        )
        .expect_err("missing glossary target");

        assert!(error.contains("glossary"));
        assert!(error.contains("State"));
    }

    fn section(text: &str) -> PersistTranslationSection {
        PersistTranslationSection {
            heading: None,
            source_heading: None,
            source_ordinal: 0,
            is_heading: false,
            text: text.into(),
            fragments: Vec::new(),
        }
    }

    fn source_block(ordinal: usize, text: &str) -> TranslationSourceBlock {
        TranslationSourceBlock {
            ordinal,
            heading: None,
            text: text.into(),
        }
    }

    fn glossary(source: &str, target: &str) -> TranslationGlossaryEntry {
        TranslationGlossaryEntry {
            source: source.into(),
            target: target.into(),
            note: None,
        }
    }
}
