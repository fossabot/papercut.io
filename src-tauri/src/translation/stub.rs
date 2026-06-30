//! Stub backend for offline translation.
//!
//! This is not a "fake translator"; it only exposes capabilities and stable
//! command responses while native translation engines are still being evaluated.

use std::collections::HashSet;
use std::sync::{Arc, Mutex};

use tauri::Emitter;

use super::config::{
    DEFAULT_BATCH_SEGMENT_LIMIT, DEFAULT_MAX_SEGMENT_CHARS, DEFAULT_TRANSLATION_JOB_PROGRESS_EVENT,
    DEFAULT_TRANSLATION_QUALITY_MODE, TRANSLATION_BACKEND_UNAVAILABLE,
};
use super::ctranslate2::CTranslate2Engine;
use super::engine::{
    TranslationBatchInput, TranslationEngine, TranslationSegmentContext, TranslationSegmentInput,
};
use super::job::{plan_translation_job, TranslationJobPlan};
use super::model_store::{directory_size, manifest_for, resolve_translation_model_dir};
use super::models::{find_planned_model, planned_models, TranslationModelDefinition};
use super::source::{load_translation_source_document, TranslationSourceDocument};
use super::state::TranslationState;
use super::storage::{
    persist_translated_document, PersistTranslationRequest, PersistTranslationSection,
};
use super::types::{
    TranslationCancelRequest, TranslationCapabilities, TranslationJobProgress,
    TranslationModelStatus, TranslationModelStatusRequest, TranslationStartRequest,
    TranslationStartResponse,
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
    state: &TranslationState,
    request: TranslationStartRequest,
) -> Result<TranslationStartResponse, String> {
    let model = find_planned_model(&request.model_id).ok_or_else(|| {
        format!(
            "Translation model {:?} is not in the planned catalog",
            request.model_id
        )
    })?;
    validate_language_pair(model, &request)?;
    let manifest = manifest_for(model);
    if !manifest.installable {
        return Err(format!(
            "{} is still a planning candidate and cannot run translation preflight yet.",
            model.name
        ));
    }
    let model_dir = resolve_translation_model_dir(app, manifest).map_err(|_| {
        format!(
            "{} must be installed before translation can run. Open the Translation tab and install the model first.",
            model.name
        )
    })?;

    let source = load_translation_source_document(app, &request.document_url)?;
    let source_blocks = source.blocks.iter().map(|block| block.text.as_str());
    let plan = plan_translation_job(
        request,
        source_blocks,
        DEFAULT_MAX_SEGMENT_CHARS,
        DEFAULT_BATCH_SEGMENT_LIMIT,
    );
    match plan {
        Ok(plan) => {
            let job_id = plan
                .request
                .job_id
                .as_deref()
                .filter(|value| !value.trim().is_empty())
                .unwrap_or(&plan.cache_key)
                .to_string();
            clear_cancelled(&state.cancelled_jobs, &job_id)?;
            let mut engine =
                CTranslate2Engine::for_installed_model(plan.request.model_id.clone(), model_dir)?;
            match run_translation_batches(app, state, &mut engine, &plan, &source, &job_id) {
                Ok(summary) => {
                    emit_translation_progress(
                        app,
                        progress(
                            &job_id,
                            "storing",
                            "Storing translated document",
                            &plan,
                            plan.total_segments,
                            plan.batches.len(),
                            &summary.preview,
                        ),
                    )?;
                    let stored = persist_translated_document(
                        app,
                        PersistTranslationRequest {
                            source: source.clone(),
                            source_language: plan.request.source_language.clone(),
                            target_language: plan.request.target_language.clone(),
                            model_id: plan.request.model_id.clone(),
                            quality_mode: plan.request.quality_mode.clone(),
                            job_id: job_id.clone(),
                            translated_sections: summary.sections,
                        },
                    )?;
                    emit_translation_progress(
                        app,
                        progress(
                            &job_id,
                            "stored",
                            "Translated document stored",
                            &plan,
                            plan.total_segments,
                            plan.batches.len(),
                            &summary.preview,
                        ),
                    )?;
                    Ok(TranslationStartResponse {
                        job_id,
                        status: "stored".into(),
                        message: format!(
                            "Stored translated document '{}': {} segment(s), {} batch(es), preview: {}",
                            stored.title,
                            plan.total_segments,
                            plan.batches.len(),
                            summary.preview
                        ),
                    })
                }
                Err(err) => {
                    let _ = clear_cancelled(&state.cancelled_jobs, &job_id);
                    let message = format!(
                        "{NOT_IMPLEMENTED} Preflight found {} translatable segments in {} batches for '{}', and confirmed installed model {} at {}. Native in-memory translation did not complete: {err}",
                        plan.total_segments,
                        plan.batches.len(),
                        source.title,
                        engine.config().model_id,
                        engine.config().model_dir.display()
                    );
                    Err(message)
                }
            }
        }
        Err(err) => Err(err),
    }
}

pub(super) fn cancel_translation(
    state: &TranslationState,
    request: TranslationCancelRequest,
) -> Result<(), String> {
    let mut cancelled = state
        .cancelled_jobs
        .lock()
        .map_err(|_| "Translation cancellation lock poisoned".to_string())?;
    cancelled.insert(request.job_id);
    Ok(())
}

struct TranslationRunSummary {
    preview: String,
    sections: Vec<PersistTranslationSection>,
}

/// Translate every planned batch and keep source-block order intact.
///
/// Segments are batched for engine throughput, but storage needs section-sized
/// text again. The source block index lets us stitch translated segments back
/// into their original document sections before the durable variant is written.
fn run_translation_batches<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    state: &TranslationState,
    engine: &mut CTranslate2Engine,
    plan: &TranslationJobPlan,
    source: &TranslationSourceDocument,
    job_id: &str,
) -> Result<TranslationRunSummary, String> {
    emit_translation_progress(
        app,
        progress(
            job_id,
            "starting",
            "Preparing translation batches",
            plan,
            0,
            0,
            "",
        ),
    )?;

    let mut completed_segments = 0;
    let mut preview = String::new();
    let mut translated_blocks = vec![String::new(); source.blocks.len()];
    for batch in &plan.batches {
        if is_cancelled(&state.cancelled_jobs, job_id)? {
            emit_translation_progress(
                app,
                progress(
                    job_id,
                    "cancelled",
                    "Translation cancelled",
                    plan,
                    completed_segments,
                    batch.index,
                    &preview,
                ),
            )?;
            clear_cancelled(&state.cancelled_jobs, job_id)?;
            return Err("Translation cancelled".into());
        }

        let outputs = engine.translate_batch(batch_input(plan, batch))?;
        completed_segments += outputs.len();
        for (segment, output) in batch.segments.iter().zip(outputs.iter()) {
            if let Some(block_text) = translated_blocks.get_mut(segment.source_block_index) {
                if !block_text.is_empty() {
                    block_text.push(' ');
                }
                block_text.push_str(output.text.trim());
            }
        }
        if preview.is_empty() {
            preview = outputs
                .iter()
                .map(|output| output.text.trim())
                .find(|text| !text.is_empty())
                .unwrap_or("")
                .to_string();
        }

        emit_translation_progress(
            app,
            progress(
                job_id,
                "translating",
                "Translated batch",
                plan,
                completed_segments,
                batch.index + 1,
                &preview,
            ),
        )?;
    }

    emit_translation_progress(
        app,
        progress(
            job_id,
            "completed",
            "Translation completed in memory",
            plan,
            completed_segments,
            plan.batches.len(),
            &preview,
        ),
    )?;
    clear_cancelled(&state.cancelled_jobs, job_id)?;
    let sections = translated_blocks
        .into_iter()
        .enumerate()
        .filter_map(|(index, text)| {
            let text = text.trim().to_string();
            if text.is_empty() {
                return None;
            }
            Some(PersistTranslationSection {
                heading: source
                    .blocks
                    .get(index)
                    .and_then(|block| block.heading.clone()),
                text,
            })
        })
        .collect();
    Ok(TranslationRunSummary {
        preview: truncate_preview(preview.trim(), 240),
        sections,
    })
}

fn batch_input(
    plan: &TranslationJobPlan,
    batch: &super::job::TranslationBatchPlan,
) -> TranslationBatchInput {
    TranslationBatchInput {
        model_id: plan.request.model_id.clone(),
        source_language: plan.request.source_language.clone(),
        target_language: plan.request.target_language.clone(),
        quality_mode: plan.request.quality_mode.clone(),
        segments: batch
            .segments
            .iter()
            .map(|segment| TranslationSegmentInput {
                id: segment.id.clone(),
                text: segment.text.clone(),
                context: TranslationSegmentContext::default(),
            })
            .collect(),
    }
}

fn progress(
    job_id: &str,
    status: &str,
    message: &str,
    plan: &TranslationJobPlan,
    completed_segments: usize,
    completed_batches: usize,
    preview: &str,
) -> TranslationJobProgress {
    let percent = if plan.total_segments == 0 {
        0
    } else {
        ((completed_segments.saturating_mul(100)) / plan.total_segments).min(100) as u8
    };
    TranslationJobProgress {
        job_id: job_id.into(),
        status: status.into(),
        message: message.into(),
        completed_segments,
        total_segments: plan.total_segments,
        completed_batches,
        total_batches: plan.batches.len(),
        percent,
        preview: truncate_preview(preview.trim(), 180),
    }
}

fn emit_translation_progress<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    progress: TranslationJobProgress,
) -> Result<(), String> {
    app.emit(DEFAULT_TRANSLATION_JOB_PROGRESS_EVENT, progress)
        .map_err(|err| format!("Failed to emit translation progress: {err}"))
}

fn is_cancelled(
    cancelled_jobs: &Arc<Mutex<HashSet<String>>>,
    job_id: &str,
) -> Result<bool, String> {
    let cancelled = cancelled_jobs
        .lock()
        .map_err(|_| "Translation cancellation lock poisoned".to_string())?;
    Ok(cancelled.contains(job_id))
}

fn clear_cancelled(
    cancelled_jobs: &Arc<Mutex<HashSet<String>>>,
    job_id: &str,
) -> Result<(), String> {
    let mut cancelled = cancelled_jobs
        .lock()
        .map_err(|_| "Translation cancellation lock poisoned".to_string())?;
    cancelled.remove(job_id);
    Ok(())
}

fn truncate_preview(text: &str, max_chars: usize) -> String {
    let mut chars = text.chars();
    let preview = chars.by_ref().take(max_chars).collect::<String>();
    if chars.next().is_some() {
        format!("{preview}...")
    } else {
        preview
    }
}

fn validate_language_pair(
    model: TranslationModelDefinition,
    request: &TranslationStartRequest,
) -> Result<(), String> {
    let source_ok = request.source_language == "auto"
        || model
            .source_languages
            .iter()
            .any(|language| *language == request.source_language);
    if !source_ok {
        return Err(format!(
            "{} does not support source language {:?}. Supported: {}",
            model.name,
            request.source_language,
            model.source_languages.join(", ")
        ));
    }

    if !model
        .target_languages
        .iter()
        .any(|language| *language == request.target_language)
    {
        return Err(format!(
            "{} does not support target language {:?}. Supported: {}",
            model.name,
            request.target_language,
            model.target_languages.join(", ")
        ));
    }

    Ok(())
}
