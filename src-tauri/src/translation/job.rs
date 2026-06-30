//! Translation job planning.
//!
//! The eventual engine runner should do three separate things: read source
//! blocks, plan bounded batches, then translate/write/cache those batches. This
//! module owns the middle step so performance limits are testable before any
//! native model runtime is linked.

#![allow(dead_code)]

use super::segment::{segment_text_blocks, TranslationTextSegment};
use super::types::TranslationStartRequest;

#[derive(Debug, Clone)]
pub(crate) struct TranslationJobPlan {
    pub(crate) cache_key: String,
    pub(crate) request: TranslationStartRequest,
    pub(crate) batches: Vec<TranslationBatchPlan>,
    pub(crate) total_segments: usize,
    pub(crate) total_source_chars: usize,
    pub(crate) max_segment_chars: usize,
    pub(crate) batch_segment_limit: usize,
}

#[derive(Debug, Clone)]
pub(crate) struct TranslationBatchPlan {
    pub(crate) index: usize,
    pub(crate) segments: Vec<TranslationTextSegment>,
}

/// Convert source text blocks into bounded engine batches for one job.
///
/// The planner validates only structural constraints: non-empty languages,
/// model id, quality mode, and segment/batch limits. Model availability and
/// language-pair support belong in the future model-install/runtime layer.
pub(crate) fn plan_translation_job<I, S>(
    request: TranslationStartRequest,
    source_blocks: I,
    max_segment_chars: usize,
    batch_segment_limit: usize,
) -> Result<TranslationJobPlan, String>
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    validate_request_shape(&request)?;
    if batch_segment_limit == 0 {
        return Err("Translation batch size must be greater than zero".into());
    }

    let segments = segment_text_blocks(source_blocks, max_segment_chars)?;
    if segments.is_empty() {
        return Err("Document has no translatable text".into());
    }

    let total_source_chars = segments
        .iter()
        .map(|segment| segment.text.chars().count())
        .sum();
    let batches = segments
        .chunks(batch_segment_limit)
        .enumerate()
        .map(|(index, chunk)| TranslationBatchPlan {
            index,
            segments: chunk.to_vec(),
        })
        .collect::<Vec<_>>();

    Ok(TranslationJobPlan {
        cache_key: build_translation_cache_key(&request),
        request,
        total_segments: segments.len(),
        total_source_chars,
        max_segment_chars,
        batch_segment_limit,
        batches,
    })
}

/// Build a stable key for completed segment caches.
///
/// A later implementation should include source content hashes per segment too.
/// This higher-level key intentionally captures settings that make translated
/// output incompatible across jobs.
pub(crate) fn build_translation_cache_key(request: &TranslationStartRequest) -> String {
    let mut hash = 0xcbf2_9ce4_8422_2325;
    hash_cache_part(&mut hash, &request.document_url);
    hash_cache_part(&mut hash, &request.source_language);
    hash_cache_part(&mut hash, &request.target_language);
    hash_cache_part(&mut hash, &request.model_id);
    hash_cache_part(&mut hash, &request.quality_mode);
    format!("{hash:016x}")
}

fn hash_cache_part(hash: &mut u64, value: &str) {
    for byte in value.len().to_le_bytes().into_iter().chain(value.bytes()) {
        *hash ^= u64::from(byte);
        *hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
}

fn validate_request_shape(request: &TranslationStartRequest) -> Result<(), String> {
    if request.document_url.trim().is_empty() {
        return Err("Translation document URL is required".into());
    }
    if request.source_language.trim().is_empty() {
        return Err("Translation source language is required".into());
    }
    if request.target_language.trim().is_empty() {
        return Err("Translation target language is required".into());
    }
    if request.model_id.trim().is_empty() {
        return Err("Translation model id is required".into());
    }
    if request.quality_mode.trim().is_empty() {
        return Err("Translation quality mode is required".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{build_translation_cache_key, plan_translation_job};
    use crate::translation::types::TranslationStartRequest;

    fn request() -> TranslationStartRequest {
        TranslationStartRequest {
            document_url: "app://document/example".into(),
            source_language: "ar".into(),
            target_language: "en".into(),
            model_id: "opus-ar-en".into(),
            quality_mode: "balanced".into(),
        }
    }

    #[test]
    fn plans_batches_from_bounded_segments() {
        let plan = plan_translation_job(request(), ["One. Two. Three. Four."], 6, 2).expect("plan");

        assert_eq!(plan.total_segments, 4);
        assert_eq!(plan.batches.len(), 2);
        assert_eq!(plan.batches[0].index, 0);
        assert_eq!(plan.batches[0].segments.len(), 2);
        assert_eq!(plan.batches[1].index, 1);
        assert_eq!(plan.batches[1].segments.len(), 2);
    }

    #[test]
    fn rejects_empty_source_text() {
        let error = plan_translation_job(request(), ["   "], 100, 4).expect_err("empty text");

        assert!(error.contains("no translatable text"));
    }

    #[test]
    fn rejects_empty_batch_limit() {
        let error = plan_translation_job(request(), ["Text."], 100, 0).expect_err("zero batch");

        assert!(error.contains("batch size"));
    }

    #[test]
    fn cache_key_changes_with_translation_settings() {
        let mut first = request();
        let mut second = request();
        second.target_language = "fr".into();

        assert_ne!(
            build_translation_cache_key(&first),
            build_translation_cache_key(&second)
        );
        first.target_language = "fr".into();
        assert_eq!(
            build_translation_cache_key(&first),
            build_translation_cache_key(&second)
        );
    }
}
