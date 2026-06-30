//! Planned offline translation model catalog.
//!
//! The catalog is intentionally descriptive for now. A future engine commit must
//! add checksums, required files, install validation, and platform gating before
//! any entry becomes downloadable or runnable.

use super::config::DEFAULT_TRANSLATION_QUALITY_MODE;
use super::types::TranslationModelInfo;

#[derive(Clone, Copy, Debug)]
pub(crate) struct TranslationModelDefinition {
    pub(crate) id: &'static str,
    pub(crate) name: &'static str,
    pub(crate) engine: &'static str,
    pub(crate) tier: &'static str,
    pub(crate) source_languages: &'static [&'static str],
    pub(crate) target_languages: &'static [&'static str],
    pub(crate) recommended_platforms: &'static [&'static str],
    pub(crate) notes: &'static str,
}

impl TranslationModelDefinition {
    /// Project inert catalog planning data into the frontend capability shape.
    ///
    /// These entries are not installable yet. They exist so the frontend and
    /// docs can discuss stable model ids/tiers while engine spikes still decide
    /// exact archives, checksums, licenses, required files, and platform gates.
    pub(crate) fn to_info(self) -> TranslationModelInfo {
        TranslationModelInfo {
            id: self.id.into(),
            name: self.name.into(),
            engine: self.engine.into(),
            tier: self.tier.into(),
            source_languages: self
                .source_languages
                .iter()
                .map(|language| (*language).into())
                .collect(),
            target_languages: self
                .target_languages
                .iter()
                .map(|language| (*language).into())
                .collect(),
            default_quality_mode: DEFAULT_TRANSLATION_QUALITY_MODE.into(),
            recommended_platforms: self
                .recommended_platforms
                .iter()
                .map(|platform| (*platform).into())
                .collect(),
            notes: self.notes.into(),
        }
    }
}

/// Planned model candidates, not an installation manifest.
///
/// A future model-download stage must replace or enrich these rows with pinned
/// source URLs, SHA-256 hashes, archive sizes, and model-specific validation.
/// Until then the capability API must continue reporting translation unavailable
/// even though these candidates are visible to development builds.
pub(crate) const PLANNED_TRANSLATION_MODELS: &[TranslationModelDefinition] = &[
    TranslationModelDefinition {
        id: "opus-mt-pair-ctranslate2",
        name: "OPUS-MT Pair Model",
        engine: "ctranslate2",
        tier: "fast",
        source_languages: &["ar", "de", "es", "fr", "ru", "zh"],
        target_languages: &["en"],
        recommended_platforms: &["desktop", "android"],
        notes: "Fast pair-specific baseline; each language pair needs license and quality review.",
    },
    TranslationModelDefinition {
        id: "translategemma-4b",
        name: "TranslateGemma 4B",
        engine: "llama.cpp",
        tier: "quality",
        source_languages: &["ar", "de", "es", "fr", "ru", "zh"],
        target_languages: &["en"],
        recommended_platforms: &["desktop"],
        notes: "Quality-focused candidate; license, quantization, RAM, and mobile feasibility need review.",
    },
    TranslationModelDefinition {
        id: "qwen3-8b",
        name: "Qwen3 8B",
        engine: "llama.cpp",
        tier: "context",
        source_languages: &["ar", "de", "es", "fr", "ru", "zh"],
        target_languages: &["en"],
        recommended_platforms: &["desktop"],
        notes: "Context-rich academic-prose experiment; needs strict prompts and QA to avoid paraphrase drift.",
    },
];

/// Return candidate metadata for capabilities/diagnostics.
///
/// Keeping this as a function instead of exporting the const directly gives
/// future storage or platform filters one place to narrow the catalog without
/// making command code understand model-family details.
pub(crate) fn planned_models() -> Vec<TranslationModelInfo> {
    PLANNED_TRANSLATION_MODELS
        .iter()
        .map(|model| model.to_info())
        .collect()
}
