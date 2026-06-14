//! Pinned constants for the native engine.
//!
//! Centralizes everything that is a fixed identifier rather than logic: the
//! Tauri event channel names and audiobook bundle format markers. Model catalog
//! metadata lives in `models.rs`; cache and bundle versions stay here so save,
//! export, and import agree by construction.

/// Event emitted with per-chunk progress during a native audiobook save.
pub(super) const SAVE_PROGRESS_EVENT: &str = "tts-native-save-progress";
/// Event emitted with download/extract progress during model install.
pub(super) const MODEL_INSTALL_PROGRESS_EVENT: &str = "tts-model-install-progress";

/// Saved-audiobook cache version. Bumping this intentionally invalidates older
/// saved records and bundles whose chunk boundaries / text normalization differ.
pub(super) const CACHE_VERSION: &str = "native-save-v4-segmented";
/// Internal saved-audiobook manifest schema. Unlike `CACHE_VERSION`, this only
/// describes metadata layout and does not change chunk ids or generated audio.
pub(super) const AUDIOBOOK_MANIFEST_VERSION: u8 = 2;

/// Leading magic bytes identifying a Papercut audiobook export bundle.
pub(super) const BUNDLE_MAGIC: &[u8] = b"PAPERCUT_AUDIOBOOK_BUNDLE_V2\n";
