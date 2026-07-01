//! Stub backend for offline translation.
//!
//! This is not a "fake translator"; it only exposes capabilities and stable
//! command responses while native translation engines are still being evaluated.

use std::collections::{BTreeMap, BTreeSet, HashSet};
use std::sync::{Arc, Mutex};

use tauri::Emitter;

use super::cache::{load_segment_cache, save_segment_cache};
use super::config::{
    DEFAULT_BATCH_SEGMENT_LIMIT, DEFAULT_MAX_SEGMENT_CHARS, DEFAULT_TRANSLATION_QUALITY_MODE,
    TRANSLATION_BACKEND_CTRANSLATE2, TRANSLATION_BACKEND_UNAVAILABLE,
    TRANSLATION_JOB_PROGRESS_EVENT,
};
use super::ctranslate2::CTranslate2Engine;
use super::engine::{
    TranslationBatchInput, TranslationEngine, TranslationSegmentContext, TranslationSegmentInput,
};
use super::inline_markup::{inline_phrase_probes_by_block, InlinePhraseProbe};
use super::job::{plan_translation_job, TranslationBatchPlan, TranslationJobPlan};
use super::model_store::{directory_size, manifest_for, resolve_translation_model_dir};
use super::models::{find_planned_model, planned_models, TranslationModelDefinition};
use super::source::{load_translation_source_document, TranslationSourceDocument};
use super::state::TranslationState;
use super::storage::{
    persist_translated_document, PersistTranslationFragment, PersistTranslationInlinePhrase,
    PersistTranslationRequest, PersistTranslationSection,
};
use super::types::{
    TranslationCancelRequest, TranslationCapabilities, TranslationGlossaryEntry,
    TranslationJobProgress, TranslationModelStatus, TranslationModelStatusRequest,
    TranslationStartRequest, TranslationStartResponse,
};

const NOT_IMPLEMENTED: &str = "Offline translation is planned but not implemented in this build.";
const MAX_INLINE_PHRASE_PROBES_PER_SEGMENT: usize = 8;

/// Report translation capability shape even when a backend is unavailable.
///
/// The UI uses this stable payload to render model choices and feature gates
/// before every platform has native inference support.
pub(super) fn translation_capabilities() -> TranslationCapabilities {
    let available = cfg!(feature = "native-translation-ctranslate2");
    TranslationCapabilities {
        available,
        backend: if available {
            TRANSLATION_BACKEND_CTRANSLATE2
        } else {
            TRANSLATION_BACKEND_UNAVAILABLE
        }
        .into(),
        reason: translation_capability_reason(available),
        platform: std::env::consts::OS.into(),
        default_quality_mode: DEFAULT_TRANSLATION_QUALITY_MODE.into(),
        models: planned_models(),
    }
}

/// Return install status for one catalog model.
///
/// This bridges planning and runtime: non-downloadable catalog entries explain
/// why they cannot run yet, while pinned manifests can report real disk state.
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
            } else if cfg!(feature = "native-translation-ctranslate2") {
                "Translation model is installable. Install it before starting a translation job."
                    .into()
            } else {
                format!(
                    "{NOT_IMPLEMENTED} The file manifest is pinned and installable, but native CTranslate2 inference is not wired yet."
                )
            },
        },
    }
}

fn translation_capability_reason(available: bool) -> String {
    let limits = format!(
        "max {DEFAULT_MAX_SEGMENT_CHARS} chars/segment, {DEFAULT_BATCH_SEGMENT_LIMIT} segments/batch"
    );
    if available {
        format!("CTranslate2 offline translation is available for pinned OPUS-MT models; {limits}.")
    } else {
        format!("{NOT_IMPLEMENTED} Planned defaults: {limits}.")
    }
}

/// Start a translation job and persist the completed output as a derived upload.
///
/// Despite the module name, this path now performs real preflight, cache reuse,
/// optional native CTranslate2 execution, and durable storage when the selected
/// model is installable and the native backend is compiled in.
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
                            "validating",
                            "Validating translated document",
                            &plan,
                            plan.total_segments,
                            summary.cached_segments,
                            0,
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
                            repair_mode: plan.request.repair_mode.clone(),
                            job_id: job_id.clone(),
                            glossary: plan.request.glossary.clone(),
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
                            summary.cached_segments,
                            0,
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
                    if err.status != "cancelled" {
                        let _ = emit_translation_progress(
                            app,
                            progress(
                                &job_id,
                                err.status,
                                &err.message,
                                &plan,
                                err.completed_segments,
                                err.cached_segments,
                                0,
                                err.completed_batches,
                                &err.preview,
                            ),
                        );
                    }
                    let message = format!(
                        "Translation did not complete. Planned {} translatable segments in {} batches for '{}', using installed model {} at {}. {}",
                        plan.total_segments,
                        plan.batches.len(),
                        source.title,
                        engine.config().model_id,
                        engine.config().model_dir.display(),
                        err.message
                    );
                    Err(message)
                }
            }
        }
        Err(err) => Err(err),
    }
}

/// Mark a running job as cancelled.
///
/// The batch loop checks this cooperative flag between batches so cancellation
/// stays simple and avoids interrupting native inference in the middle of a
/// backend call.
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
    cached_segments: usize,
    sections: Vec<PersistTranslationSection>,
}

struct TranslationRunFailure {
    status: &'static str,
    message: String,
    completed_segments: usize,
    cached_segments: usize,
    completed_batches: usize,
    preview: String,
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
) -> Result<TranslationRunSummary, TranslationRunFailure> {
    emit_translation_progress(
        app,
        progress(
            job_id,
            "starting",
            "Preparing translation batches",
            plan,
            0,
            0,
            0,
            0,
            "",
        ),
    )
    .map_err(|err| run_failure("failed", err, 0, 0, 0, ""))?;

    let mut completed_segments = 0;
    let mut cached_segments = 0;
    let mut preview = String::new();
    let mut translated_blocks = vec![String::new(); source.blocks.len()];
    let mut translated_fragments =
        vec![Vec::<PersistTranslationFragment>::new(); source.blocks.len()];
    let inline_phrase_probes = inline_phrase_probes_by_block(&source.view_html);
    let mut cache =
        load_segment_cache(app, plan).map_err(|err| run_failure("failed", err, 0, 0, 0, ""))?;
    for batch in &plan.batches {
        if is_cancelled(&state.cancelled_jobs, job_id).map_err(|err| {
            run_failure(
                "failed",
                err,
                completed_segments,
                cached_segments,
                batch.index,
                &preview,
            )
        })? {
            emit_translation_progress(
                app,
                progress(
                    job_id,
                    "cancelled",
                    "Translation cancelled",
                    plan,
                    completed_segments,
                    cached_segments,
                    0,
                    batch.index,
                    &preview,
                ),
            )
            .map_err(|err| {
                run_failure(
                    "failed",
                    err,
                    completed_segments,
                    cached_segments,
                    batch.index,
                    &preview,
                )
            })?;
            clear_cancelled(&state.cancelled_jobs, job_id).map_err(|err| {
                run_failure(
                    "failed",
                    err,
                    completed_segments,
                    cached_segments,
                    batch.index,
                    &preview,
                )
            })?;
            return Err(run_failure(
                "cancelled",
                "Translation cancelled",
                completed_segments,
                cached_segments,
                batch.index,
                &preview,
            ));
        }

        let inline_phrase_hints =
            translate_inline_phrase_hints(engine, plan, batch, &inline_phrase_probes);
        let mut pending_batch = TranslationBatchPlan {
            index: batch.index,
            segments: Vec::new(),
        };
        let mut reused_segments_in_batch = 0;
        let mut materialized_memory_reuse = false;
        for segment in &batch.segments {
            if let Some(cached_text) = cache.translated_text_for(segment).map(str::to_owned) {
                completed_segments += 1;
                cached_segments += 1;
                reused_segments_in_batch += 1;
                append_translated_segment(
                    &mut translated_blocks,
                    &mut translated_fragments,
                    segment,
                    segment.source_block_index,
                    &cached_text,
                    inline_phrase_hints
                        .get(&segment.id)
                        .cloned()
                        .unwrap_or_default(),
                );
                if preview.is_empty() && !cached_text.trim().is_empty() {
                    preview = cached_text.trim().to_string();
                }
            } else if let Some(memory_text) =
                cache.translated_text_for_source(segment).map(str::to_owned)
            {
                completed_segments += 1;
                cached_segments += 1;
                reused_segments_in_batch += 1;
                materialized_memory_reuse = true;
                append_translated_segment(
                    &mut translated_blocks,
                    &mut translated_fragments,
                    segment,
                    segment.source_block_index,
                    &memory_text,
                    inline_phrase_hints
                        .get(&segment.id)
                        .cloned()
                        .unwrap_or_default(),
                );
                if preview.is_empty() && !memory_text.trim().is_empty() {
                    preview = memory_text.trim().to_string();
                }
                cache.store_translation(segment, memory_text);
            } else {
                pending_batch.segments.push(segment.clone());
            }
        }

        let reused_only = pending_batch.segments.is_empty();
        if !reused_only {
            let outputs = engine
                .translate_batch(batch_input(plan, &pending_batch))
                .map_err(|err| {
                    run_failure(
                        "failed",
                        format!("Native in-memory translation did not complete: {err}"),
                        completed_segments,
                        cached_segments,
                        batch.index,
                        &preview,
                    )
                })?;
            let mut translated_count = 0;
            for (segment, output) in pending_batch.segments.iter().zip(outputs.iter()) {
                let translated_text = output.text.trim().to_string();
                if translated_text.is_empty() {
                    return Err(run_failure(
                        "failed",
                        format!(
                            "Native translation returned empty output for source section {}",
                            segment.source_block_index + 1
                        ),
                        completed_segments,
                        cached_segments,
                        batch.index,
                        &preview,
                    ));
                }
                translated_count += 1;
                append_translated_segment(
                    &mut translated_blocks,
                    &mut translated_fragments,
                    segment,
                    segment.source_block_index,
                    &translated_text,
                    inline_phrase_hints
                        .get(&segment.id)
                        .cloned()
                        .unwrap_or_default(),
                );
                if preview.is_empty() && !translated_text.is_empty() {
                    preview = translated_text.clone();
                }
                cache.store_translation(segment, translated_text);
            }
            completed_segments += translated_count;
            save_segment_cache(app, plan, &cache).map_err(|err| {
                run_failure(
                    "failed",
                    err,
                    completed_segments,
                    cached_segments,
                    batch.index,
                    &preview,
                )
            })?;
        } else if materialized_memory_reuse {
            save_segment_cache(app, plan, &cache).map_err(|err| {
                run_failure(
                    "failed",
                    err,
                    completed_segments,
                    cached_segments,
                    batch.index,
                    &preview,
                )
            })?;
        }

        emit_translation_progress(
            app,
            progress(
                job_id,
                "translating",
                if reused_only {
                    "Reused cached batch"
                } else {
                    "Translated batch"
                },
                plan,
                completed_segments,
                cached_segments,
                reused_segments_in_batch,
                batch.index + 1,
                &preview,
            ),
        )
        .map_err(|err| {
            run_failure(
                "failed",
                err,
                completed_segments,
                cached_segments,
                batch.index + 1,
                &preview,
            )
        })?;
    }

    emit_translation_progress(
        app,
        progress(
            job_id,
            "completed",
            "Translation completed in memory",
            plan,
            completed_segments,
            cached_segments,
            0,
            plan.batches.len(),
            &preview,
        ),
    )
    .map_err(|err| {
        run_failure(
            "failed",
            err,
            completed_segments,
            cached_segments,
            plan.batches.len(),
            &preview,
        )
    })?;
    clear_cancelled(&state.cancelled_jobs, job_id).map_err(|err| {
        run_failure(
            "failed",
            err,
            completed_segments,
            cached_segments,
            plan.batches.len(),
            &preview,
        )
    })?;
    let mut current_translated_heading: Option<String> = None;
    let sections = translated_blocks
        .into_iter()
        .enumerate()
        .map(|(index, text)| {
            let text = text.trim().to_string();
            let source_block = source.blocks.get(index);
            let heading = source_block.and_then(|block| block.heading.clone());
            let is_heading = source_block.is_some_and(|block| {
                block
                    .heading
                    .as_deref()
                    .is_some_and(|heading| heading.trim() == block.text.trim())
            });
            if is_heading {
                current_translated_heading = Some(text.clone());
            }
            PersistTranslationSection {
                heading: current_translated_heading
                    .clone()
                    .or_else(|| heading.clone()),
                source_heading: heading,
                source_ordinal: source_block.map(|block| block.ordinal).unwrap_or(index),
                is_heading,
                text,
                fragments: translated_fragments.get(index).cloned().unwrap_or_default(),
            }
        })
        .collect();
    Ok(TranslationRunSummary {
        preview: truncate_preview(preview.trim(), 240),
        cached_segments,
        sections,
    })
}

fn run_failure(
    status: &'static str,
    message: impl Into<String>,
    completed_segments: usize,
    cached_segments: usize,
    completed_batches: usize,
    preview: &str,
) -> TranslationRunFailure {
    TranslationRunFailure {
        status,
        message: message.into(),
        completed_segments,
        cached_segments,
        completed_batches,
        preview: truncate_preview(preview.trim(), 180),
    }
}

/// Translate emphasized source phrases as small repair hints.
///
/// Main OPUS-MT output does not expose word alignment. These probes give the
/// renderer a target phrase to exact-match when bold/italic source text was
/// translated rather than carried over unchanged. Probe failure is non-fatal:
/// plain/proportional inline rendering is safer than failing a completed book.
fn translate_inline_phrase_hints(
    engine: &mut CTranslate2Engine,
    plan: &TranslationJobPlan,
    batch: &TranslationBatchPlan,
    probes_by_block: &[Vec<InlinePhraseProbe>],
) -> BTreeMap<String, Vec<PersistTranslationInlinePhrase>> {
    let mut owners = Vec::new();
    let mut inputs = Vec::new();
    for segment in &batch.segments {
        let probes = inline_phrase_probes_for_segment(segment, probes_by_block);
        for (index, probe) in probes.into_iter().enumerate() {
            let id = format!("{}:inline:{index}", segment.id);
            owners.push((id.clone(), segment.id.clone(), probe.text.clone()));
            inputs.push(TranslationSegmentInput {
                id,
                text: probe.text,
                context: TranslationSegmentContext {
                    glossary: glossary_for_segment(&plan.request.glossary, &segment.text),
                    ..TranslationSegmentContext::default()
                },
            });
        }
    }
    if inputs.is_empty() {
        return BTreeMap::new();
    }

    let owner_by_probe = owners
        .into_iter()
        .map(|(probe_id, owner_id, source_text)| (probe_id, (owner_id, source_text)))
        .collect::<BTreeMap<_, _>>();
    let Ok(outputs) = engine.translate_batch(TranslationBatchInput {
        model_id: plan.request.model_id.clone(),
        source_language: plan.request.source_language.clone(),
        target_language: plan.request.target_language.clone(),
        quality_mode: plan.request.quality_mode.clone(),
        repair_mode: plan.request.repair_mode.clone(),
        glossary: plan.request.glossary.clone(),
        segments: inputs,
    }) else {
        return BTreeMap::new();
    };

    let mut hints = BTreeMap::<String, Vec<PersistTranslationInlinePhrase>>::new();
    for output in outputs {
        let Some((owner_id, source_text)) = owner_by_probe.get(&output.id) else {
            continue;
        };
        let translated = output.text.trim();
        if translated.is_empty() {
            continue;
        }
        hints
            .entry(owner_id.clone())
            .or_default()
            .push(PersistTranslationInlinePhrase {
                source_text: source_text.clone(),
                text: translated.to_string(),
            });
    }
    hints
}

fn inline_phrase_probes_for_segment(
    segment: &super::segment::TranslationTextSegment,
    probes_by_block: &[Vec<InlinePhraseProbe>],
) -> Vec<InlinePhraseProbe> {
    let Some(probes) = probes_by_block.get(segment.source_block_index) else {
        return Vec::new();
    };
    let mut seen = BTreeSet::new();
    probes
        .iter()
        .filter(|probe| {
            probe.source_start >= segment.source_start && probe.source_end <= segment.source_end
        })
        .filter(|probe| seen.insert(probe.text.to_lowercase()))
        .take(MAX_INLINE_PHRASE_PROBES_PER_SEGMENT)
        .cloned()
        .collect()
}

fn append_translated_segment(
    blocks: &mut [String],
    fragments: &mut [Vec<PersistTranslationFragment>],
    segment: &super::segment::TranslationTextSegment,
    source_block_index: usize,
    text: &str,
    inline_phrases: Vec<PersistTranslationInlinePhrase>,
) {
    let Some(block_text) = blocks.get_mut(source_block_index) else {
        return;
    };
    let text = text.trim();
    if text.is_empty() {
        return;
    }
    if !block_text.is_empty() {
        block_text.push(' ');
    }
    block_text.push_str(text);
    if let Some(block_fragments) = fragments.get_mut(source_block_index) {
        block_fragments.push(PersistTranslationFragment {
            source_start: segment.source_start,
            source_end: segment.source_end,
            source_text: segment.text.trim().to_string(),
            text: text.to_string(),
            inline_phrases,
        });
    }
}

/// Convert a planned batch into the engine-agnostic input shape.
///
/// Keeping this small boundary lets future engines add context/glossary fields
/// without changing the planner or storage code.
fn batch_input(
    plan: &TranslationJobPlan,
    batch: &super::job::TranslationBatchPlan,
) -> TranslationBatchInput {
    TranslationBatchInput {
        model_id: plan.request.model_id.clone(),
        source_language: plan.request.source_language.clone(),
        target_language: plan.request.target_language.clone(),
        quality_mode: plan.request.quality_mode.clone(),
        repair_mode: plan.request.repair_mode.clone(),
        glossary: plan.request.glossary.clone(),
        segments: batch
            .segments
            .iter()
            .map(|segment| TranslationSegmentInput {
                id: segment.id.clone(),
                text: segment.text.clone(),
                context: TranslationSegmentContext {
                    glossary: glossary_for_segment(&plan.request.glossary, &segment.text),
                    ..TranslationSegmentContext::default()
                },
            })
            .collect(),
    }
}

/// Select glossary entries relevant to one segment by exact source-term match.
///
/// This keeps prompt/context payloads bounded today. Fuzzy glossary matching
/// can come later if needed; exact matching uses standard string search and
/// avoids a text-similarity dependency until benchmarks justify one.
fn glossary_for_segment(
    glossary: &[TranslationGlossaryEntry],
    segment_text: &str,
) -> Vec<TranslationGlossaryEntry> {
    let lower_segment = segment_text.to_lowercase();
    glossary
        .iter()
        .filter(|entry| lower_segment.contains(&entry.source.to_lowercase()))
        .cloned()
        .collect()
}

/// Build the frontend progress event from source/batch counters.
///
/// `cached_segments` and `reused_segments_in_batch` are separate so the UI can
/// distinguish overall resume wins from a single batch that was fully reused.
fn progress(
    job_id: &str,
    status: &str,
    message: &str,
    plan: &TranslationJobPlan,
    completed_segments: usize,
    cached_segments: usize,
    reused_segments_in_batch: usize,
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
        cached_segments,
        translated_segments: completed_segments.saturating_sub(cached_segments),
        reused_segments_in_batch,
        completed_batches,
        total_batches: plan.batches.len(),
        percent,
        preview: truncate_preview(preview.trim(), 180),
    }
}

/// Emit progress through the single event name the React hook listens to.
fn emit_translation_progress<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    progress: TranslationJobProgress,
) -> Result<(), String> {
    app.emit(TRANSLATION_JOB_PROGRESS_EVENT, progress)
        .map_err(|err| format!("Failed to emit translation progress: {err}"))
}

/// Check the cooperative cancellation set without exposing the lock shape.
fn is_cancelled(
    cancelled_jobs: &Arc<Mutex<HashSet<String>>>,
    job_id: &str,
) -> Result<bool, String> {
    let cancelled = cancelled_jobs
        .lock()
        .map_err(|_| "Translation cancellation lock poisoned".to_string())?;
    Ok(cancelled.contains(job_id))
}

/// Remove a completed/cancelled job id so a later retry starts cleanly.
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

/// Keep progress previews readable and event payloads small.
fn truncate_preview(text: &str, max_chars: usize) -> String {
    let mut chars = text.chars();
    let preview = chars.by_ref().take(max_chars).collect::<String>();
    if chars.next().is_some() {
        format!("{preview}...")
    } else {
        preview
    }
}

/// Validate request languages against the selected model catalog entry.
///
/// The UI should prevent invalid pairs, but this backend check protects saved
/// jobs, direct command calls, and future import/export replay paths.
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
