//! Text segmentation for future translation jobs.
//!
//! Document parsers already preserve the safe HTML and sections. Translation
//! still needs bounded text payloads so native engines can batch work without
//! overflowing context windows or freezing the UI on very large books.

#![allow(dead_code)]

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct TranslationTextSegment {
    pub(crate) id: String,
    pub(crate) source_block_index: usize,
    pub(crate) text: String,
}

/// Split document text blocks into stable, bounded translation segments.
///
/// The segment ids are deterministic from source block order, which gives the
/// future job runner a cheap cache key for resume/retry. This is deliberately a
/// text-only primitive; HTML element mapping and anchor preservation should sit
/// above it so format-specific logic stays out of engine code.
pub(crate) fn segment_text_blocks<I, S>(
    blocks: I,
    max_chars: usize,
) -> Result<Vec<TranslationTextSegment>, String>
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    if max_chars == 0 {
        return Err("Translation segment size must be greater than zero".into());
    }

    let mut segments = Vec::new();
    for (block_index, block) in blocks.into_iter().enumerate() {
        let normalized = normalize_translation_whitespace(block.as_ref());
        if normalized.is_empty() {
            continue;
        }
        let parts = split_block_into_segments(&normalized, max_chars);
        for (part_index, text) in parts.into_iter().enumerate() {
            segments.push(TranslationTextSegment {
                id: format!("b{block_index}:s{part_index}"),
                source_block_index: block_index,
                text,
            });
        }
    }

    Ok(segments)
}

fn normalize_translation_whitespace(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn split_block_into_segments(text: &str, max_chars: usize) -> Vec<String> {
    if text.chars().count() <= max_chars {
        return vec![text.to_string()];
    }

    let mut segments = Vec::new();
    let mut current = String::new();

    for sentence in sentence_like_parts(text) {
        if sentence.chars().count() > max_chars {
            push_current(&mut segments, &mut current);
            segments.extend(split_oversized_part(sentence, max_chars));
            continue;
        }

        let proposed_len =
            current.chars().count() + sentence.chars().count() + usize::from(!current.is_empty());
        if proposed_len > max_chars {
            push_current(&mut segments, &mut current);
        }
        if !current.is_empty() {
            current.push(' ');
        }
        current.push_str(sentence);
    }

    push_current(&mut segments, &mut current);
    segments
}

fn sentence_like_parts(text: &str) -> Vec<&str> {
    let mut parts = Vec::new();
    let mut start = 0;

    for (index, ch) in text.char_indices() {
        if is_sentence_boundary(ch) {
            let end = index + ch.len_utf8();
            let part = text[start..end].trim();
            if !part.is_empty() {
                parts.push(part);
            }
            start = end;
        }
    }

    let tail = text[start..].trim();
    if !tail.is_empty() {
        parts.push(tail);
    }
    parts
}

fn is_sentence_boundary(ch: char) -> bool {
    matches!(
        ch,
        '.' | '!' | '?' | '\u{061f}' | '\u{06d4}' | '\u{3002}' | '\u{ff01}' | '\u{ff1f}'
    )
}

fn split_oversized_part(text: &str, max_chars: usize) -> Vec<String> {
    let mut segments = Vec::new();
    let mut current = String::new();

    for word in text.split_whitespace() {
        if word.chars().count() > max_chars {
            push_current(&mut segments, &mut current);
            segments.extend(split_long_word(word, max_chars));
            continue;
        }

        let proposed_len =
            current.chars().count() + word.chars().count() + usize::from(!current.is_empty());
        if proposed_len > max_chars {
            push_current(&mut segments, &mut current);
        }
        if !current.is_empty() {
            current.push(' ');
        }
        current.push_str(word);
    }

    push_current(&mut segments, &mut current);
    segments
}

fn split_long_word(word: &str, max_chars: usize) -> Vec<String> {
    let mut segments = Vec::new();
    let mut current = String::new();

    for ch in word.chars() {
        if current.chars().count() == max_chars {
            segments.push(current);
            current = String::new();
        }
        current.push(ch);
    }
    if !current.is_empty() {
        segments.push(current);
    }

    segments
}

fn push_current(segments: &mut Vec<String>, current: &mut String) {
    if current.is_empty() {
        return;
    }
    segments.push(std::mem::take(current));
}

#[cfg(test)]
mod tests {
    use super::segment_text_blocks;

    #[test]
    fn skips_empty_blocks_and_assigns_stable_ids() {
        let segments = segment_text_blocks(["   ", "One. Two."], 20).expect("segments");

        assert_eq!(segments.len(), 1);
        assert_eq!(segments[0].id, "b1:s0");
        assert_eq!(segments[0].source_block_index, 1);
        assert_eq!(segments[0].text, "One. Two.");
    }

    #[test]
    fn splits_sentence_like_boundaries_under_limit() {
        let segments = segment_text_blocks(["Alpha. Beta. Gamma."], 13).expect("segments");
        let texts: Vec<_> = segments.into_iter().map(|segment| segment.text).collect();

        assert_eq!(texts, vec!["Alpha. Beta.", "Gamma."]);
    }

    #[test]
    fn splits_long_unpunctuated_text_by_words() {
        let segments = segment_text_blocks(["alpha beta gamma delta"], 12).expect("segments");
        let texts: Vec<_> = segments.into_iter().map(|segment| segment.text).collect();

        assert_eq!(texts, vec!["alpha beta", "gamma delta"]);
    }

    #[test]
    fn splits_oversized_words_on_char_boundaries() {
        let segments = segment_text_blocks(["abcdef"], 2).expect("segments");
        let texts: Vec<_> = segments.into_iter().map(|segment| segment.text).collect();

        assert_eq!(texts, vec!["ab", "cd", "ef"]);
    }

    #[test]
    fn rejects_zero_limit() {
        let error = segment_text_blocks(["text"], 0).expect_err("zero limit should fail");

        assert!(error.contains("greater than zero"));
    }
}
