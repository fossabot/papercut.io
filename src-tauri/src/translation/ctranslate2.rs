//! CTranslate2 engine adapter for the OPUS-MT/Marian MVP.
//!
//! The real native binding remains feature-gated so normal builds do not pull
//! in C++/SentencePiece dependencies. When `native-translation-ctranslate2` is
//! enabled, this adapter loads `ct2rs::Translator` from a verified on-disk
//! model directory and can translate bounded batches. That lets us smoke-test
//! OPUS-MT before committing to full document rewrite/storage semantics.

#![allow(dead_code)]

use std::path::PathBuf;

use super::engine::{TranslationBatchInput, TranslationEngine, TranslationSegmentOutput};

#[cfg(feature = "native-translation-ctranslate2")]
type NativeTranslator = ct2rs::Translator<ct2rs::tokenizers::auto::Tokenizer>;

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
    #[cfg(feature = "native-translation-ctranslate2")]
    translator: Option<NativeTranslator>,
}

impl CTranslate2Engine {
    /// Load the native runtime from a verified on-disk model folder.
    ///
    /// This is intentionally separate from `new` because loading CTranslate2
    /// can mmap model weights, initialize tokenizers, and fail on platform
    /// linkage. Callers should do this only after model-manifest validation.
    pub(crate) fn for_installed_model(
        model_id: impl Into<String>,
        model_dir: PathBuf,
    ) -> Result<Self, String> {
        let config = CTranslate2EngineConfig {
            model_id: model_id.into(),
            model_dir,
            device: CTranslate2Device::Cpu,
            inter_threads: 1,
            intra_threads: default_intra_threads(),
        };
        Self::load(config)
    }

    /// Create the future CTranslate2 engine adapter without loading native code.
    ///
    /// The real implementation should validate converted model files here, then
    /// initialize the chosen binding/wrapper. Keeping construction explicit
    /// avoids hiding expensive model loads inside job planning code.
    pub(crate) fn new(config: CTranslate2EngineConfig) -> Self {
        Self {
            config,
            #[cfg(feature = "native-translation-ctranslate2")]
            translator: None,
        }
    }

    /// Initialize the native translator only when the feature is compiled in.
    ///
    /// Non-native builds still construct the adapter so shared planning/storage
    /// code compiles, but translation returns a clear feature-gate error.
    fn load(config: CTranslate2EngineConfig) -> Result<Self, String> {
        #[cfg(feature = "native-translation-ctranslate2")]
        {
            let translator_config = native_config(&config);
            let translator = ct2rs::Translator::new(&config.model_dir, &translator_config)
                .map_err(|err| {
                    format!(
                        "Failed to load CTranslate2 model {} at {}: {err}",
                        config.model_id,
                        config.model_dir.display()
                    )
                })?;
            return Ok(Self {
                config,
                translator: Some(translator),
            });
        }

        #[cfg(not(feature = "native-translation-ctranslate2"))]
        {
            Ok(Self::new(config))
        }
    }

    pub(crate) fn config(&self) -> &CTranslate2EngineConfig {
        &self.config
    }
}

impl TranslationEngine for CTranslate2Engine {
    fn translate_batch(
        &mut self,
        input: TranslationBatchInput,
    ) -> Result<Vec<TranslationSegmentOutput>, String> {
        #[cfg(feature = "native-translation-ctranslate2")]
        {
            let translator = self.translator.as_ref().ok_or_else(|| {
                "CTranslate2 runtime was not loaded. Use for_installed_model before translation."
                    .to_string()
            })?;
            let sources = input
                .segments
                .iter()
                .map(|segment| segment.text.as_str())
                .collect::<Vec<_>>();
            let mut options: ct2rs::TranslationOptions<String, String> = Default::default();
            options.max_batch_size = sources.len().max(1);
            options.replace_unknowns = true;

            let started = std::time::Instant::now();
            let translated = translator
                .translate_batch(&sources, &options, None)
                .map_err(|err| format!("CTranslate2 batch translation failed: {err}"))?;
            let engine_elapsed = started.elapsed();
            if translated.len() != input.segments.len() {
                return Err(format!(
                    "CTranslate2 returned {} outputs for {} input segments",
                    translated.len(),
                    input.segments.len()
                ));
            }

            return Ok(input
                .segments
                .into_iter()
                .zip(translated)
                .map(|(segment, (text, _score))| TranslationSegmentOutput {
                    id: segment.id,
                    text,
                    engine_elapsed,
                })
                .collect());
        }

        #[cfg(not(feature = "native-translation-ctranslate2"))]
        {
            let _ = input;
        }
        Err(
            "CTranslate2 translation is selected for the MVP, but this build was not compiled with native-translation-ctranslate2."
                .into(),
        )
    }
}

/// Convert Papercut's small runtime config into ct2rs options.
///
/// The MVP is CPU-only because that is the common desktop/Android baseline.
/// GPU/device selection should be added here later without touching callers.
#[cfg(feature = "native-translation-ctranslate2")]
fn native_config(config: &CTranslate2EngineConfig) -> ct2rs::Config {
    let mut native = ct2rs::Config {
        device: match config.device {
            CTranslate2Device::Cpu => ct2rs::Device::CPU,
        },
        num_threads_per_replica: config.intra_threads,
        max_queued_batches: config.inter_threads.max(1) as i32,
        ..Default::default()
    };
    native.device_indices = vec![0];
    native
}

/// Pick a conservative CPU thread count for long-running translation jobs.
///
/// Translation runs can sit beside UI, TTS, and downloads. Capping at 8 avoids
/// oversubscribing large desktops while still using enough parallelism to make
/// OPUS-MT practical.
fn default_intra_threads() -> usize {
    std::thread::available_parallelism()
        .map(|count| count.get().clamp(1, 8))
        .unwrap_or(1)
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

    #[cfg(not(feature = "native-translation-ctranslate2"))]
    #[test]
    fn prepares_engine_from_installed_model_dir_without_native_feature() {
        let engine = CTranslate2Engine::for_installed_model(
            "opus-mt-fr-en-ctranslate2",
            PathBuf::from("/tmp/fr-en"),
        )
        .expect("engine");

        assert_eq!(engine.config().model_id, "opus-mt-fr-en-ctranslate2");
        assert_eq!(engine.config().model_dir, PathBuf::from("/tmp/fr-en"));
        assert!(engine.config().intra_threads >= 1);
    }
}
