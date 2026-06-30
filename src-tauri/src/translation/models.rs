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
    pub(crate) manifest_state: &'static str,
    pub(crate) source_languages: &'static [&'static str],
    pub(crate) target_languages: &'static [&'static str],
    pub(crate) recommended_platforms: &'static [&'static str],
    pub(crate) license_notes: &'static str,
    pub(crate) size_notes: &'static str,
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
            manifest_state: self.manifest_state.into(),
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
            license_notes: self.license_notes.into(),
            size_notes: self.size_notes.into(),
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
        manifest_state: "candidate-only",
        source_languages: &["ar", "de", "es", "fr", "ru", "zh"],
        target_languages: &["en"],
        recommended_platforms: &["desktop", "android"],
        license_notes: "Requires pair-specific license and model-card review before download support.",
        size_notes: "Varies by language pair; expected to be the smallest first spike.",
        notes: "Fast pair-specific baseline; each language pair needs license and quality review.",
    },
    TranslationModelDefinition {
        id: "translategemma-4b",
        name: "TranslateGemma 4B",
        engine: "llama.cpp",
        tier: "quality",
        manifest_state: "candidate-only",
        source_languages: &["ar", "de", "es", "fr", "ru", "zh"],
        target_languages: &["en"],
        recommended_platforms: &["desktop"],
        license_notes: "Requires Google model-license review and packaging approval.",
        size_notes: "Large desktop candidate; mobile feasibility must be benchmarked before listing.",
        notes: "Quality-focused candidate; license, quantization, RAM, and mobile feasibility need review.",
    },
    TranslationModelDefinition {
        id: "qwen3-8b",
        name: "Qwen3 8B",
        engine: "llama.cpp",
        tier: "context",
        manifest_state: "candidate-only",
        source_languages: &["ar", "de", "es", "fr", "ru", "zh"],
        target_languages: &["en"],
        recommended_platforms: &["desktop"],
        license_notes: "Requires model-license, prompt-policy, and redistribution review.",
        size_notes: "Large desktop experiment; not a default mobile candidate.",
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

pub(crate) fn find_planned_model(id: &str) -> Option<TranslationModelDefinition> {
    PLANNED_TRANSLATION_MODELS
        .iter()
        .copied()
        .find(|model| model.id == id)
}

#[cfg(test)]
mod tests {
    use std::collections::HashSet;

    use super::{find_planned_model, planned_models, PLANNED_TRANSLATION_MODELS};

    #[test]
    fn planned_model_ids_are_unique() {
        let mut seen = HashSet::new();

        for model in PLANNED_TRANSLATION_MODELS {
            assert!(seen.insert(model.id), "duplicate model id {}", model.id);
        }
    }

    #[test]
    fn planned_models_remain_candidate_only() {
        for model in planned_models() {
            assert_eq!(model.manifest_state, "candidate-only");
            assert!(!model.license_notes.is_empty());
            assert!(!model.size_notes.is_empty());
        }
    }

    #[test]
    fn finds_planned_model_by_id() {
        let model = find_planned_model("opus-mt-pair-ctranslate2").expect("model");

        assert_eq!(model.engine, "ctranslate2");
        assert!(find_planned_model("missing-model").is_none());
    }
}
