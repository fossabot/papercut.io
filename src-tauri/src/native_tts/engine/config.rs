//! Pinned constants for the native engine.
//!
//! Centralizes everything that is a fixed identifier rather than logic: the
//! Tauri event channel names, the pinned Kokoro model asset, and the audiobook
//! bundle format markers. Keeping the model id and cache version here means the
//! save manifest, export metadata, and bundle validation all agree by
//! construction.

/// Event emitted with per-chunk progress during a native audiobook save.
pub(super) const SAVE_PROGRESS_EVENT: &str = "tts-native-save-progress";
/// Event emitted with download/extract progress during model install.
pub(super) const MODEL_INSTALL_PROGRESS_EVENT: &str = "tts-model-install-progress";

/// Directory name of the extracted model and the asset basename.
pub(super) const MODEL_NAME: &str = "kokoro-multi-lang-v1_0";
pub(super) const MODEL_SOURCE_LABEL: &str = "k2-fsa/sherpa-onnx Kokoro multi-lang v1.0";
pub(super) const MODEL_URL: &str = "https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/kokoro-multi-lang-v1_0.tar.bz2";
pub(super) const MODEL_SHA256: &str =
    "c133d26353d776da730870dac7da07dbfc9a5e3bc80cc5e8e83ab6e823be7046";
pub(super) const MODEL_ARCHIVE_BYTES: u64 = 349_418_188;

/// Logical model id stamped into save manifests / export bundles and checked on
/// import so audiobooks generated for a different model are rejected.
pub(super) const MODEL_ID: &str = "sherpa-onnx/kokoro-multi-lang-v1_0";
/// Saved-audiobook cache version. Bumping this intentionally invalidates older
/// saved records and bundles whose chunk boundaries / text normalization differ.
pub(super) const CACHE_VERSION: &str = "native-save-v3-360-sanitized";

/// Leading magic bytes identifying a Papercut audiobook export bundle.
pub(super) const BUNDLE_MAGIC: &[u8] = b"PAPERCUT_AUDIOBOOK_BUNDLE_V2\n";
