//! Stub backend for offline translation.
//!
//! This is not a "fake translator"; it only exposes capabilities and stable
//! command responses while native translation engines are still being evaluated.

use super::config::{
    DEFAULT_BATCH_SEGMENT_LIMIT, DEFAULT_MAX_SEGMENT_CHARS, DEFAULT_TRANSLATION_QUALITY_MODE,
    TRANSLATION_BACKEND_UNAVAILABLE,
};
use super::job::plan_translation_job;
use super::models::planned_models;
use super::source::load_translation_source_document;
use super::types::{
    TranslationCancelRequest, TranslationCapabilities, TranslationModelStatus,
    TranslationModelStatusRequest, TranslationStartRequest, TranslationStartResponse,
};

const NOT_IMPLEMENTED: &str = "Offline translation is planned but not implemented in this build.";

pub(super) fn translation_capabilities() -> TranslationCapabilities {
    TranslationCapabilities {
        available: false,
        backend: TRANSLATION_BACKEND_UNAVAILABLE.into(),
        reason: format!(
            "{NOT_IMPLEMENTED} Planned defaults: max {DEFAULT_MAX_SEGMENT_CHARS} chars/segment, {DEFAULT_BATCH_SEGMENT_LIMIT} segments/batch."
        ),
        platform: std::env::consts::OS.into(),
        default_quality_mode: DEFAULT_TRANSLATION_QUALITY_MODE.into(),
        models: planned_models(),
    }
}

pub(super) fn translation_model_status(
    request: TranslationModelStatusRequest,
) -> TranslationModelStatus {
    TranslationModelStatus {
        model_id: request.model_id,
        installed: false,
        installing: false,
        model_dir: None,
        source_url: String::new(),
        source_label: "Offline translation model catalog".into(),
        archive_bytes: 0,
        installed_bytes: 0,
        sha256: String::new(),
        message: NOT_IMPLEMENTED.into(),
    }
}

pub(super) fn start_translation<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    request: TranslationStartRequest,
) -> Result<TranslationStartResponse, String> {
    let source = load_translation_source_document(app, &request.document_url)?;
    let source_blocks = source.blocks.iter().map(|block| block.text.as_str());
    let plan = plan_translation_job(
        request,
        source_blocks,
        DEFAULT_MAX_SEGMENT_CHARS,
        DEFAULT_BATCH_SEGMENT_LIMIT,
    );
    match plan {
        Ok(plan) => Err(format!(
            "{NOT_IMPLEMENTED} Preflight found {} translatable segments in {} batches for '{}'.",
            plan.total_segments,
            plan.batches.len(),
            source.title
        )),
        Err(err) => Err(err),
    }
}

pub(super) fn cancel_translation(request: TranslationCancelRequest) -> Result<(), String> {
    let _ = request.job_id;
    Ok(())
}
