//! First-pass quality gates for completed translation output.
//!
//! These checks are intentionally cheap and deterministic. They do not judge
//! translation quality yet; they only prevent storing obviously broken output
//! such as empty translations or generated HTML with internal links that no
//! longer resolve.

use std::collections::HashSet;

use kuchikiki::{parse_html, traits::TendrilSink, NodeRef};

use super::storage::PersistTranslationSection;

/// Validate generated translated HTML before it is promoted into reader/search storage.
///
/// This runs after rendering because some problems only exist in final HTML.
/// Keeping it before durable writes avoids indexing variants that users can
/// open but whose footnotes/internal navigation are already known broken.
pub(crate) fn validate_translated_output(
    html: &str,
    sections: &[PersistTranslationSection],
) -> Result<(), String> {
    validate_non_empty_sections(sections)?;
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

#[cfg(test)]
mod tests {
    use super::validate_translated_output;
    use crate::translation::storage::PersistTranslationSection;

    #[test]
    fn accepts_internal_links_with_targets() {
        validate_translated_output(
            "<article><p><a href=\"#note-1\">note</a></p><p id=\"note-1\">body</p></article>",
            &[section("Translated text")],
        )
        .expect("valid links");
    }

    #[test]
    fn rejects_missing_internal_link_targets() {
        let error = validate_translated_output(
            "<article><p><a href=\"#missing\">note</a></p></article>",
            &[section("Translated text")],
        )
        .expect_err("broken target");

        assert!(error.contains("#missing"));
    }

    #[test]
    fn rejects_empty_translated_sections() {
        let error = validate_translated_output("<article></article>", &[section("   ")])
            .expect_err("empty translation");

        assert!(error.contains("empty"));
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
}
