//! Native translation engine boundary.
//!
//! This module intentionally does not depend on CTranslate2 yet. The next
//! implementation step can wire these contracts to `ct2rs`, `ctranslate2`, or
//! another runtime without changing command DTOs or storage semantics.

#![allow(dead_code)]

use std::time::Duration;

#[derive(Debug, Clone)]
pub(crate) struct TranslationBatchInput {
    pub(crate) model_id: String,
    pub(crate) source_language: String,
    pub(crate) target_language: String,
    pub(crate) quality_mode: String,
    pub(crate) segments: Vec<TranslationSegmentInput>,
}

#[derive(Debug, Clone)]
pub(crate) struct TranslationSegmentInput {
    pub(crate) id: String,
    pub(crate) text: String,
    pub(crate) context: TranslationSegmentContext,
}

#[derive(Debug, Clone, Default)]
pub(crate) struct TranslationSegmentContext {
    pub(crate) title: Option<String>,
    pub(crate) heading: Option<String>,
    pub(crate) previous_text: Option<String>,
    pub(crate) next_text: Option<String>,
}

#[derive(Debug, Clone)]
pub(crate) struct TranslationSegmentOutput {
    pub(crate) id: String,
    pub(crate) text: String,
    pub(crate) engine_elapsed: Duration,
}

pub(crate) trait TranslationEngine {
    /// Translate a bounded batch of document segments.
    ///
    /// Engines should preserve segment ids exactly so the caller can rebuild
    /// document order and cache completed work. Context fields are hints for
    /// quality, not text that should be emitted into the translated output.
    fn translate_batch(
        &mut self,
        input: TranslationBatchInput,
    ) -> Result<Vec<TranslationSegmentOutput>, String>;
}
