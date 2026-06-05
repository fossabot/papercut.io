//! Housekeeping for imported/saved audiobooks: read source HTML and delete.
//!
//! These are the small, non-streaming operations that don't belong to the
//! export or import pipelines but still act on the same on-disk layout.

use std::fs;

use super::super::paths::{
    audiobook_dir, imported_upload_dir, imported_upload_id_from_document_url,
    remove_dir_and_count_bytes,
};
use crate::native_tts::types::{
    NativeAudiobookDeleteRequest, NativeAudiobookDeleteResponse,
    NativeImportedAudiobookSourceRequest,
};

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

/// Delete a saved audiobook's audio cache, and optionally its imported source.
///
/// Always removes the per-audiobook audio directory. When `delete_user_upload`
/// is set and the document is an import, also removes the stored source upload.
/// Returns what was deleted and how many bytes were reclaimed.
///
/// Rust note: `remove_dir_and_count_bytes` returns a `(bool, u64)` tuple
/// (deleted?, bytes); `result.0` / `result.1` access those positional fields.
pub(crate) fn delete_audiobook_native(
    app: tauri::AppHandle,
    request: NativeAudiobookDeleteRequest,
) -> Result<NativeAudiobookDeleteResponse, String> {
    let audio_dir = audiobook_dir(&app, &request.audiobook_id)?;
    let (deleted_audio, audio_bytes) =
        remove_dir_and_count_bytes(&audio_dir, "audiobook audio cache")?;

    let mut deleted_user_upload = false;
    let mut upload_bytes = 0u64;
    if request.delete_user_upload {
        // Only imported documents have a deletable upload dir; a non-import URL
        // simply fails the id parse and is skipped.
        if let Ok(upload_id) = imported_upload_id_from_document_url(&request.document_url) {
            let upload_dir = imported_upload_dir(&app, &upload_id)?;
            let result = remove_dir_and_count_bytes(&upload_dir, "imported audiobook source")?;
            deleted_user_upload = result.0;
            upload_bytes = result.1;
        }
    }

    Ok(NativeAudiobookDeleteResponse {
        deleted_audio,
        deleted_user_upload,
        bytes_freed: audio_bytes + upload_bytes,
    })
}
