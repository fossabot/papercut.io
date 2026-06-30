//! Translation feature constants.
//!
//! These are conservative planning limits for future engines. They are not
//! enforced by real inference yet, but keeping them centralized prevents each
//! engine spike from picking incompatible chunk/job defaults.

pub(crate) const TRANSLATION_BACKEND_UNAVAILABLE: &str = "translation-unavailable";
pub(crate) const TRANSLATION_MODEL_INSTALL_PROGRESS_EVENT: &str =
    "translation-model-install-progress";
pub(crate) const DEFAULT_TRANSLATION_QUALITY_MODE: &str = "balanced";
pub(crate) const DEFAULT_MAX_SEGMENT_CHARS: usize = 2_500;
pub(crate) const DEFAULT_BATCH_SEGMENT_LIMIT: usize = 16;
