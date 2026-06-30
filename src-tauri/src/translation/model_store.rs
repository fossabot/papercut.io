//! Translation model manifest and cache path helpers.
//!
//! This layer mirrors the TTS model-store boundary, but stays deliberately
//! non-downloadable until we pin real converted CTranslate2 archives. The goal
//! is to make install/status code reviewable now without inventing URLs,
//! checksums, or required-file lists that have not been validated on desktop
//! and Android.

use std::fs;
use std::path::{Path, PathBuf};

use tauri::{Manager, Runtime};

use super::models::TranslationModelDefinition;

#[derive(Clone, Copy, Debug)]
pub(crate) struct TranslationModelManifest {
    pub(crate) model_id: &'static str,
    pub(crate) directory_name: &'static str,
    pub(crate) source_label: &'static str,
    pub(crate) source_url: &'static str,
    pub(crate) sha256: &'static str,
    pub(crate) archive_bytes: u64,
    pub(crate) required_files: &'static [&'static str],
    pub(crate) installable: bool,
}

impl TranslationModelManifest {
    /// Validate only models that have a pinned archive contract.
    ///
    /// Candidate-only rows intentionally return false even if a developer has a
    /// similarly named folder on disk. That prevents accidental local files from
    /// making the UI claim a model is installed before the manifest has a real
    /// URL, checksum, and required-file list.
    pub(crate) fn has_required_files(self, dir: &Path) -> bool {
        self.installable
            && !self.required_files.is_empty()
            && self
                .required_files
                .iter()
                .all(|path| dir.join(path).is_file())
    }
}

/// Convert catalog metadata into the future install manifest shape.
///
/// For now every planned translation model is non-installable. When the first
/// CTranslate2 archives are chosen, this is the narrow place that should grow
/// source URLs, SHA-256 hashes, archive sizes, and required-file validation.
pub(crate) fn manifest_for(model: TranslationModelDefinition) -> TranslationModelManifest {
    TranslationModelManifest {
        model_id: model.id,
        directory_name: model.id,
        source_label: model.name,
        source_url: "",
        sha256: "",
        archive_bytes: 0,
        required_files: &[],
        installable: false,
    }
}

/// Permanent location for verified translation models.
///
/// Translation models are separate from TTS models and generated translated
/// documents: `<app-data>/translation/models/{model-id}`. Keeping these roots
/// split makes future cleanup and per-feature storage accounting simpler.
pub(crate) fn installed_translation_model_dir<R: Runtime>(
    app: &tauri::AppHandle<R>,
    manifest: TranslationModelManifest,
) -> Result<PathBuf, String> {
    Ok(translation_models_root(app)?.join(manifest.directory_name))
}

/// Scratch root for future downloads/extraction work.
///
/// This is not used to download anything yet, but defining it now keeps the
/// eventual installer aligned with TTS: work happens in cache, then a verified
/// model is promoted into app data.
#[allow(dead_code)]
pub(crate) fn translation_model_work_dir<R: Runtime>(
    app: &tauri::AppHandle<R>,
    manifest: TranslationModelManifest,
) -> Result<PathBuf, String> {
    let cache_dir = app
        .path()
        .app_cache_dir()
        .or_else(|_| app.path().app_data_dir())
        .map_err(|err| {
            format!("Failed to resolve cache dir for offline translation model install: {err}")
        })?;
    Ok(cache_dir
        .join("translation-model-installer")
        .join(manifest.directory_name))
}

pub(crate) fn resolve_translation_model_dir<R: Runtime>(
    app: &tauri::AppHandle<R>,
    manifest: TranslationModelManifest,
) -> Result<PathBuf, String> {
    let model_dir = installed_translation_model_dir(app, manifest)?;
    if manifest.has_required_files(&model_dir) {
        return Ok(model_dir);
    }

    Err(format!(
        "Offline translation model {} is not installed. Checked: {}",
        manifest.model_id,
        model_dir.display()
    ))
}

pub(crate) fn directory_size(path: &Path) -> Result<u64, String> {
    if !path.exists() {
        return Ok(0);
    }
    let metadata = fs::metadata(path).map_err(|err| {
        format!(
            "Failed to inspect translation model storage {}: {err}",
            path.display()
        )
    })?;
    if metadata.is_file() {
        return Ok(metadata.len());
    }

    let mut total = 0;
    for entry in fs::read_dir(path).map_err(|err| {
        format!(
            "Failed to read translation model storage {}: {err}",
            path.display()
        )
    })? {
        let entry =
            entry.map_err(|err| format!("Failed to inspect translation model file: {err}"))?;
        total += directory_size(&entry.path())?;
    }
    Ok(total)
}

fn translation_models_root<R: Runtime>(app: &tauri::AppHandle<R>) -> Result<PathBuf, String> {
    let app_data = app.path().app_data_dir().map_err(|err| {
        format!("Failed to resolve app data dir for offline translation model: {err}")
    })?;
    Ok(app_data.join("translation").join("models"))
}

#[cfg(test)]
mod tests {
    use super::manifest_for;
    use crate::translation::models::find_planned_model;

    #[test]
    fn planned_models_are_not_installable_without_pinned_archives() {
        let model = find_planned_model("opus-mt-es-en-ctranslate2").expect("model");
        let manifest = manifest_for(model);

        assert!(!manifest.installable);
        assert!(manifest.source_url.is_empty());
        assert!(manifest.sha256.is_empty());
        assert_eq!(manifest.archive_bytes, 0);
        assert!(manifest.required_files.is_empty());
    }
}
