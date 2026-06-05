//! Housekeeping for imported/saved audiobooks: read source HTML and delete.
//!
//! These are the small, non-streaming operations that don't belong to the
//! export or import pipelines but still act on the same on-disk layout.

use std::fs;

use serde::Deserialize;
use tauri::Manager;

use super::super::paths::{
    audiobook_dir, imported_upload_dir, imported_upload_id_from_document_url,
    remove_dir_and_count_bytes,
};
use crate::native_tts::types::{
    NativeAudiobookDeleteRequest, NativeAudiobookDeleteResponse,
    NativeImportedAudiobookSourceRequest,
};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredAudiobookManifest {
    document_url: String,
}

/// Return the stored `source.html` for an imported audiobook document.
///
/// Imported documents have URLs like `/user-uploads/<id>.html`; this extracts
/// the id, locates the upload directory, and reads the HTML back as a String
/// for the reader UI.
pub(crate) fn get_imported_audiobook_source(
    app: tauri::AppHandle,
    request: NativeImportedAudiobookSourceRequest,
) -> Result<String, String> {
    let upload_id = imported_upload_id_from_document_url(&request.document_url)?;
    let path = imported_upload_dir(&app, &upload_id)?.join("source.html");
    fs::read_to_string(&path).map_err(|err| {
        format!(
            "Failed to read imported audiobook source {}: {err}",
            path.display()
        )
    })
}

/// Delete saved audiobook data while preserving a predictable cleanup order.
///
/// Normal requests remove the directory derived from the supplied audiobook id.
/// Recovery requests can additionally remove every historical cache whose
/// manifest belongs to the same imported document, because an earlier frontend
/// upgrade may have lost the exact cache id. The imported source directory is
/// removed last when requested. All caller-controlled URL/path inputs are
/// validated and resolved before the first filesystem mutation.
pub(crate) fn delete_audiobook_native(
    app: tauri::AppHandle,
    request: NativeAudiobookDeleteRequest,
) -> Result<NativeAudiobookDeleteResponse, String> {
    // Resolve and validate every caller-controlled path before deleting anything.
    let upload_id = if request.delete_all_for_document || request.delete_user_upload {
        Some(imported_upload_id_from_document_url(&request.document_url)?)
    } else {
        None
    };
    let upload_dir = if request.delete_user_upload {
        Some(imported_upload_dir(
            &app,
            upload_id.as_deref().ok_or_else(|| {
                "Imported audiobook upload id is required for source deletion".to_string()
            })?,
        )?)
    } else {
        None
    };
    let audio_dir = audiobook_dir(&app, &request.audiobook_id)?;

    let (mut deleted_audio, mut audio_bytes) =
        remove_dir_and_count_bytes(&audio_dir, "audiobook audio cache")?;

    if request.delete_all_for_document {
        let result = delete_audiobooks_for_document(&app, &request.document_url)?;
        deleted_audio |= result.0;
        audio_bytes += result.1;
    }

    let (deleted_user_upload, upload_bytes) = if let Some(upload_dir) = upload_dir {
        remove_dir_and_count_bytes(&upload_dir, "imported audiobook source")?
    } else {
        (false, 0)
    };

    Ok(NativeAudiobookDeleteResponse {
        deleted_audio,
        deleted_user_upload,
        bytes_freed: audio_bytes + upload_bytes,
    })
}

/// Recover caches whose exact ids are no longer present in browser storage.
///
/// The scan is limited to Papercut's app-data audiobook root. Each child must
/// contain a readable native save manifest whose document URL exactly matches
/// the validated imported-document URL supplied by the caller. Matching cache
/// directories are removed with the same byte-counting helper as normal delete.
fn delete_audiobooks_for_document(
    app: &tauri::AppHandle,
    document_url: &str,
) -> Result<(bool, u64), String> {
    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|err| format!("Failed to resolve app data dir for audiobook cleanup: {err}"))?;
    let root = app_data.join("audiobooks");
    if !root.is_dir() {
        return Ok((false, 0));
    }

    let mut deleted = false;
    let mut bytes_freed = 0u64;
    for entry in fs::read_dir(&root)
        .map_err(|err| format!("Failed to scan audiobook cache {}: {err}", root.display()))?
    {
        let entry = entry.map_err(|err| {
            format!(
                "Failed to read audiobook cache entry in {}: {err}",
                root.display()
            )
        })?;
        let dir = entry.path();
        if !dir.is_dir() {
            continue;
        }

        let manifest = match fs::read(dir.join("manifest.json"))
            .ok()
            .and_then(|bytes| serde_json::from_slice::<StoredAudiobookManifest>(&bytes).ok())
        {
            Some(manifest) => manifest,
            None => continue,
        };
        if manifest.document_url != document_url {
            continue;
        }

        let result = remove_dir_and_count_bytes(&dir, "recovered audiobook audio cache")?;
        deleted |= result.0;
        bytes_freed += result.1;
    }

    Ok((deleted, bytes_freed))
}
