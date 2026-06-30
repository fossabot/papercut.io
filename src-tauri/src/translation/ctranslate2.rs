//! CTranslate2 engine slot for the OPUS-MT/Marian MVP.
//!
//! This is intentionally a non-inference shell. It fixes where CTranslate2
//! integration will attach while we validate whether `ct2rs` is enough for
//! desktop + Android or whether Papercut needs a direct C++/FFI wrapper.

#![allow(dead_code)]

use std::path::PathBuf;

use super::engine::{TranslationBatchInput, TranslationEngine, TranslationSegmentOutput};

#[derive(Debug, Clone)]
pub(crate) struct CTranslate2EngineConfig {
    pub(crate) model_id: String,
    pub(crate) model_dir: PathBuf,
    pub(crate) device: CTranslate2Device,
    pub(crate) inter_threads: usize,
    pub(crate) intra_threads: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum CTranslate2Device {
    Cpu,
}

pub(crate) struct CTranslate2Engine {
    config: CTranslate2EngineConfig,
}

impl CTranslate2Engine {
    /// Create the future CTranslate2 engine adapter without loading native code.
    ///
    /// The real implementation should validate converted model files here, then
    /// initialize the chosen binding/wrapper. Keeping construction explicit
    /// avoids hiding expensive model loads inside job planning code.
    pub(crate) fn new(config: CTranslate2EngineConfig) -> Self {
        Self { config }
    }

    pub(crate) fn config(&self) -> &CTranslate2EngineConfig {
        &self.config
    }
}

impl TranslationEngine for CTranslate2Engine {
    fn translate_batch(
        &mut self,
        _input: TranslationBatchInput,
    ) -> Result<Vec<TranslationSegmentOutput>, String> {
        Err(
            "CTranslate2 translation is selected for the MVP, but the native binding is not wired yet."
                .into(),
        )
    }
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use super::{CTranslate2Device, CTranslate2Engine, CTranslate2EngineConfig};

    #[test]
    fn stores_engine_config_without_loading_native_runtime() {
        let engine = CTranslate2Engine::new(CTranslate2EngineConfig {
            model_id: "opus-mt-es-en-ctranslate2".into(),
            model_dir: PathBuf::from("/tmp/model"),
            device: CTranslate2Device::Cpu,
            inter_threads: 1,
            intra_threads: 4,
        });

        assert_eq!(engine.config().model_id, "opus-mt-es-en-ctranslate2");
        assert_eq!(engine.config().device, CTranslate2Device::Cpu);
    }
}
