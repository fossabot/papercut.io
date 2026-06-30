//! Runtime state for offline translation jobs and model installs.
//!
//! Keep this small and feature-local. Translation model installation should not
//! reuse the TTS state lock because the two features can install/download
//! independently and may eventually have different cancellation semantics.

use std::collections::HashSet;
use std::sync::{Arc, Mutex};

pub struct TranslationState {
    pub(crate) model_installing: Arc<Mutex<HashSet<String>>>,
}

impl Default for TranslationState {
    fn default() -> Self {
        Self {
            model_installing: Arc::new(Mutex::new(HashSet::new())),
        }
    }
}
