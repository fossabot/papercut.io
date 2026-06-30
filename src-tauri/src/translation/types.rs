//! Serde DTOs crossing the offline-translation Tauri boundary.
//!
//! Keep this module as the leaf of the translation tree. Commands, stubs, and
//! future native engines should share these structs instead of inventing
//! frontend-specific shapes in each layer.

use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TranslationCapabilities {
    pub(crate) available: bool,
    pub(crate) backend: String,
    pub(crate) reason: String,
    pub(crate) platform: String,
    pub(crate) default_quality_mode: String,
    pub(crate) models: Vec<TranslationModelInfo>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TranslationModelInfo {
    pub(crate) id: String,
    pub(crate) name: String,
    pub(crate) engine: String,
    pub(crate) tier: String,
    pub(crate) manifest_state: String,
    pub(crate) source_languages: Vec<String>,
    pub(crate) target_languages: Vec<String>,
    pub(crate) default_quality_mode: String,
    pub(crate) recommended_platforms: Vec<String>,
    pub(crate) license_notes: String,
    pub(crate) size_notes: String,
    pub(crate) notes: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TranslationModelStatus {
    pub(crate) model_id: String,
    pub(crate) installed: bool,
    pub(crate) installing: bool,
    pub(crate) model_dir: Option<String>,
    pub(crate) source_url: String,
    pub(crate) source_label: String,
    pub(crate) archive_bytes: u64,
    pub(crate) installed_bytes: u64,
    pub(crate) sha256: String,
    pub(crate) message: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TranslationModelStatusRequest {
    pub(crate) model_id: String,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TranslationModelInstallProgress {
    pub(crate) model_id: String,
    pub(crate) status: String,
    pub(crate) message: String,
    pub(crate) downloaded_bytes: u64,
    pub(crate) total_bytes: u64,
    pub(crate) percent: u8,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TranslationModelInstallResponse {
    pub(crate) model_id: String,
    pub(crate) model_dir: String,
    pub(crate) bytes: u64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TranslationStartRequest {
    #[serde(default)]
    pub(crate) job_id: Option<String>,
    pub(crate) document_url: String,
    pub(crate) source_language: String,
    pub(crate) target_language: String,
    pub(crate) model_id: String,
    pub(crate) quality_mode: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TranslationStartResponse {
    pub(crate) job_id: String,
    pub(crate) status: String,
    pub(crate) message: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TranslationJobProgress {
    pub(crate) job_id: String,
    pub(crate) status: String,
    pub(crate) message: String,
    pub(crate) completed_segments: usize,
    pub(crate) total_segments: usize,
    pub(crate) completed_batches: usize,
    pub(crate) total_batches: usize,
    pub(crate) percent: u8,
    pub(crate) preview: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TranslationCancelRequest {
    pub(crate) job_id: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TranslatedDocumentInfo {
    pub(crate) id: String,
    pub(crate) source_document_url: String,
    pub(crate) title: String,
    pub(crate) source_language: String,
    pub(crate) target_language: String,
    pub(crate) model_id: String,
    pub(crate) status: String,
    pub(crate) created_at_ms: u128,
    pub(crate) updated_at_ms: u128,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TranslationDeleteRequest {
    pub(crate) id: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TranslationDeleteResponse {
    pub(crate) id: String,
    pub(crate) deleted: bool,
    pub(crate) bytes_freed: u64,
    pub(crate) message: String,
}
