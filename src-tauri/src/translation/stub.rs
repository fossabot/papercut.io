//! Stub backend for offline translation.
//!
//! This is not a "fake translator"; it only exposes capabilities and stable
//! command responses while native translation engines are still being evaluated.

use super::config::{
    DEFAULT_BATCH_SEGMENT_LIMIT, DEFAULT_MAX_SEGMENT_CHARS, DEFAULT_TRANSLATION_QUALITY_MODE,
    TRANSLATION_BACKEND_UNAVAILABLE,
};
use super::job::plan_translation_job;
use super::model_store::{directory_size, manifest_for, resolve_translation_model_dir};
use super::models::{find_planned_model, planned_models};
use super::source::load_translation_source_document;
use super::state::TranslationState;
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

pub(super) fn translation_model_status<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    state: &tauri::State<'_, TranslationState>,
    request: TranslationModelStatusRequest,
) -> TranslationModelStatus {
    let Some(model) = find_planned_model(&request.model_id) else {
        return TranslationModelStatus {
            model_id: request.model_id,
            installed: false,
            installing: false,
            model_dir: None,
            source_url: String::new(),
            source_label: "Unknown offline translation model".into(),
            archive_bytes: 0,
            installed_bytes: 0,
            sha256: String::new(),
            message: "Translation model is not in the planned catalog.".into(),
        };
    };

    let manifest = manifest_for(model);
    let installing = state
        .model_installing
        .lock()
        .map(|guard| guard.contains(manifest.directory_name))
        .unwrap_or(false);
    match resolve_translation_model_dir(app, manifest) {
        Ok(model_dir) => TranslationModelStatus {
            model_id: manifest.model_id.into(),
            installed: true,
            installing,
            model_dir: Some(model_dir.display().to_string()),
            source_url: manifest.source_url.into(),
            source_label: manifest.source_label.into(),
            archive_bytes: manifest.total_bytes(),
            installed_bytes: directory_size(&model_dir).unwrap_or(0),
            sha256: String::new(),
            message: "Offline translation model installed".into(),
        },
        Err(_) => TranslationModelStatus {
            model_id: manifest.model_id.into(),
            installed: false,
            installing,
            model_dir: None,
            source_url: manifest.source_url.into(),
            source_label: format!("{} ({})", model.name, model.manifest_state),
            archive_bytes: manifest.total_bytes(),
            installed_bytes: 0,
            sha256: String::new(),
            message: if manifest.files.is_empty() {
                format!(
                    "{NOT_IMPLEMENTED} This candidate is not downloadable until source URL, checksum, license, required files, and platform gates are reviewed."
                )
            } else {
                format!(
                    "{NOT_IMPLEMENTED} The file manifest is pinned and installable, but native CTranslate2 inference is not wired yet."
                )
            },
        },
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
