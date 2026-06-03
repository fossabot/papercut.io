//! Serde data-transfer objects exchanged with the frontend.
//!
//! Fields are `pub(crate)` so sibling modules (pipeline, store, search) can
//! build and read them while the structs stay private to the upload feature.

use serde::{Deserialize, Serialize};

/// Metadata for one stored upload, returned by import and list.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct UploadedDocument {
    pub(crate) id: String,
    pub(crate) url: String,
    pub(crate) title: String,
    pub(crate) format: String,
    pub(crate) imported_at_ms: u128,
    pub(crate) bytes: u64,
    pub(crate) sections: usize,
}

/// One FTS hit: a matching section with a highlighted snippet.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct UploadedDocumentSearchResult {
    pub(crate) id: String,
    pub(crate) document_id: String,
    pub(crate) url: String,
    pub(crate) title: String,
    pub(crate) excerpt: String,
    pub(crate) section_title: Option<String>,
    pub(crate) section_index: usize,
}

/// Outcome of a delete, including bytes reclaimed from app data.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct UploadedDocumentDeleteResult {
    pub(crate) id: String,
    pub(crate) url: String,
    pub(crate) bytes_freed: u64,
}

/// Request to read the stored source HTML of an uploaded document.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct UploadedDocumentSourceRequest {
    pub(crate) document_url: String,
}

/// Request to run an FTS search over uploaded documents.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct UploadedDocumentSearchRequest {
    pub(crate) query: String,
    pub(crate) limit: Option<usize>,
}

/// Request to delete one uploaded document by its URL.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct UploadedDocumentDeleteRequest {
    pub(crate) document_url: String,
}
