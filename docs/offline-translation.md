# Offline Translation Roadmap

Papercut does not implement offline translation yet. This document tracks the recommended path for adding it without weakening the current document, search, reader, or TTS architecture.

The goal is high-quality offline translation for long-form HTML and EPUB books, primarily into English, while keeping the app responsive on desktop and mobile. The feature should feel like audiobook saving: the user starts a long-running job, the backend performs bounded native work, progress is visible, results are cached, and the finished output becomes durable user data.

## Product Goals

- Translate imported HTML and EPUB documents offline.
- Preserve the original document unchanged.
- Produce a translated document variant that can be opened, searched, and used for TTS.
- Support long-running translation jobs with progress, cancel/resume, and clear failure states.
- Use model catalogs, verified downloads, and app-data caches like native TTS.
- Prioritize translation quality for books and textbooks, not just short webpage snippets.
- Keep desktop and mobile model choices separate when needed.

## Non-Goals For The First Version

- Do not translate an entire book in one model request.
- Do not rewrite the original uploaded source.
- Do not require cloud translation.
- Do not attempt word-perfect bilingual highlighting in the first release.
- Do not add PDF-specific translation behavior until PDF import/viewing has its own locators.
- Do not make one model serve every language pair if pair-specific models produce better results.

## Recommended Architecture

Translation should be a document-variant pipeline, not a reader-only overlay.

```text
Uploaded HTML/EPUB
  -> existing parser/sanitizer
  -> parsed sections and stable locators
  -> translation job
  -> translated safe HTML variant
  -> SQLite metadata + FTS index
  -> normal reader/search/TTS surfaces
```

This keeps the current contracts intact:

- `document_uploads` continues to own safe source extraction and section records.
- Translation consumes the parsed/stored document output instead of reparsing raw files in React.
- The reader opens a translated document variant the same way it opens normal imported documents.
- Search indexes the translated text as normal SQLite FTS rows.
- TTS generates audio from the translated document, so highlighting maps to translated DOM text instead of trying to align audio to a separate source-language DOM.

## Rust Module Shape

Add translation as a separate native feature area, parallel to native TTS:

```text
src-tauri/src/translation/
  commands.rs       # Tauri command edge and event subscription plumbing
  config.rs         # size limits, chunk limits, feature constants
  engine.rs         # shared engine trait and dispatch
  jobs.rs           # long-running translate/save job orchestration
  model.rs          # download, verify, extract, install, model status
  models.rs         # catalog metadata and language-pair support
  segment.rs        # document/chapter/paragraph/sentence segmentation
  storage.rs        # translated variant paths and cache keys
  quality.rs        # output checks and repair hooks
  types.rs          # serde DTOs crossing the Tauri boundary
```

Keep dependencies pointing inward:

```text
commands -> jobs -> { engine, model, segment, storage, quality }
models/config/types have no app-state side effects
document_uploads stays format-focused and does not depend on translation
```

This prevents translation from leaking into EPUB/HTML parser code and keeps future PDF support clean.

## Frontend Module Shape

Use small React/API modules similar to TTS:

```text
src/translation/
  api/nativeTranslation.ts       # invoke commands and subscribe to progress events
  components/TranslationPanel.tsx
  components/TranslationPanel.css
  hooks/useTranslationManager.ts
  storage/translationPreferences.ts
  models.ts                     # TypeScript fallback catalog for browser preview
  types.ts
```

The document list should show translated variants as durable documents, not transient UI state. A translated variant should carry visible metadata such as:

- source document title
- source language
- target language
- model name/version
- translation status
- created/updated time

## Long-Book Job Pattern

Long documents need bounded, resumable work. Recommended flow:

1. Validate selected source document and target language.
2. Load source section metadata and stored safe HTML.
3. Segment by chapter, heading, paragraph, sentence, and protected inline ranges.
4. Build a document memory packet:
   - title
   - author, if known
   - heading hierarchy
   - recurring terms and named entities
   - user glossary entries
   - style preference, such as literal, fluent, or academic
5. Translate in bounded batches under the model context limit.
6. Cache each translated segment by source hash, model id, target language, glossary hash, and settings.
7. Run quality checks on each segment.
8. Assemble translated safe HTML with original anchors, footnotes, headings, images, and document structure preserved where possible.
9. Store translated variant metadata and source HTML in app data.
10. Index translated sections into SQLite FTS.
11. Surface completion in the Library and Search views.

This is the same mental model as audiobook saving, but the durable output is translated HTML plus index rows instead of WAV chunks plus timing data.

## Quality Strategy

Model choice alone will not make textbook translation good. Papercut should add book-aware quality controls from the start.

Required first-pass checks:

- Empty output detection.
- Wrong target language detection.
- Repeated-output loop detection.
- Length ratio sanity checks.
- Missing protected term checks.
- Broken anchor or tag checks.
- Chapter/section progress logging.

High-value quality upgrades:

- User-editable glossary per document or collection.
- Translation memory for repeated source sentences and phrases.
- Named-entity consistency across a book.
- Chapter-level repair pass for terminology and tone.
- Per-section regeneration.
- Side-by-side source/translation diff view for manual review.

## Performance Rules

- Never translate full books in one call.
- Keep model inference off the WebView thread.
- Download models on demand, verify checksums, and atomically promote complete installs.
- Batch sentences or paragraphs, but cap total tokens per request.
- Cache segment translations so resume work does not recompute finished sections.
- Persist job state after each section or batch.
- Stream progress events with current chapter, completed segments, total segments, elapsed time, and current model.
- Make CPU thread count configurable where the engine supports it.
- Prefer quantized models for default local use.
- Keep mobile model catalogs smaller and stricter than desktop catalogs.

Quality should not be sacrificed for speed by silently switching models. If a model is faster but weaker, expose it as a speed/quality choice.

## Model And Engine Recommendations

Papercut should support a catalog, not one universal model.

| Tier | Candidate | Engine | Best Use | Notes |
| --- | --- | --- | --- | --- |
| Fast MVP | OPUS-MT / Marian pair models | CTranslate2 | common pair translation, mobile-friendly baseline | small, fast, quality varies by pair |
| Quality desktop | TranslateGemma 12B | llama.cpp or other local runtime after spike | high-quality book translation into English | heavy, license review required |
| Quality edge experiment | TranslateGemma 4B | llama.cpp / GGUF after spike | smaller high-quality model | possible high-end mobile candidate, still heavy |
| Context-rich fallback | Qwen3 8B or 14B | llama.cpp / GGUF | academic prose, Chinese-heavy work, glossary-aware prompts | strong but more generative and less task-bounded |
| Multilingual research | MADLAD-400 3B-MT | CTranslate2 or Candle spike | broad language coverage with Apache-2.0 license | heavier than pair models |
| HTML-aware reference | Bergamot | C++ or Wasm spike | tag alignment and sentence iteration ideas | not quality default for academic books |
| Avoid default | NLLB | CTranslate2 possible | broad research comparison only | CC-BY-NC and model card says not production/document translation |

### Recommended Initial Language Pairs

Start with pairs that can be manually judged against real books:

- Arabic -> English
- Spanish -> English
- French -> English
- Russian -> English
- Chinese -> English
- German -> English

Each pair should have at least one short sample, one long chapter sample, and one textbook/academic sample in manual testing notes.

## Engine Evaluation Order

1. **CTranslate2 spike**
   - Best first implementation target.
   - Designed for optimized Transformer inference.
   - Supports Marian/OPUS-MT, NLLB, MADLAD-400, T5-style models, and quantization.
   - Native C++ packaging work is the main cost.

2. **llama.cpp / GGUF spike**
   - Best path for TranslateGemma and Qwen-style local LLMs.
   - Good desktop ecosystem and quantization support.
   - Prompting must be tightly constrained to avoid paraphrase drift and hallucination.

3. **Bergamot spike**
   - Valuable for HTML alignment and sentence iteration.
   - Do not assume Firefox-style browser translation quality is enough for academic books.
   - Use as a markup-preservation reference even if not the primary quality engine.

4. **Candle or ONNX Runtime spike**
   - Consider only if it reduces packaging complexity for a chosen model.
   - Avoid writing a fragile custom decoder unless a model clearly warrants it.

## Storage And Cache Identity

Translated variants need stable identity. Include:

- source document id
- source document content hash
- source language
- target language
- model id
- model version/checksum
- engine id/version
- translation settings
- glossary hash
- parser version
- segmenter version

Recommended tables, subject to migration review:

```text
translated_documents
  id
  source_document_id
  source_hash
  source_language
  target_language
  model_id
  engine_id
  settings_json
  glossary_hash
  status
  source_path
  created_at
  updated_at

translation_segments
  translated_document_id
  ordinal
  source_locator_json
  source_hash
  translated_text
  status
  quality_json
```

Search rows can reuse the existing uploaded-document section storage once the translated document is promoted as a variant document.

## UI/UX Requirements

First release should be plain and reliable:

- Add **Translate** action for uploaded HTML/EPUB documents.
- Keep document-level actions clear in the reader: users should choose whether they are saving an audiobook or starting translation instead of interpreting one overloaded save icon.
- Add a top-level **Translate** tab so long-running translation jobs, model downloads, translated variants, and diagnostics have a dedicated home like Audiobooks.
- Let user choose source language, target language, model, quality mode, and glossary if available.
- Show model install state like TTS.
- Show progress by chapter/section, not an indeterminate spinner.
- Support cancel/resume.
- Show translated copies in the Library.
- Show machine-translation caveat.
- Keep diagnostics under an advanced toggle.
- Never block reading the original while translation runs.

Mobile:

- Use smaller default models.
- Show storage size before download.
- Warn when model/job may be slow or battery-heavy.
- Avoid wide side-by-side translation UI until a translated variant exists.

## Implementation Stages

Each stage should be easy to review and commit independently.

### Stage 1: Planning And Contracts

- Add this document.
- Link it from README and document-upload docs.
- Add a non-functional Translation tab placeholder so the app has a clear future navigation target.
- Change the reader save affordance into a document action menu with **Save Audiobook** and **Translate Document** choices. The translation choice should route to the placeholder tab until backend translation exists.
- Decide branch name, feature flag name, and initial model candidates.
- Do not add translation model downloads, jobs, storage, or fake progress yet.

### Stage 2: Backend Skeleton

- Add `src-tauri/src/translation/` with `types`, `models`, `config`, `commands`, and a stub engine.
- Register commands behind a disabled or stubbed feature.
- Return deterministic "translation unavailable" capabilities in browser/non-native paths.
- Add unit tests for model lookup and cache-key construction.

### Stage 3: Translated Variant Storage

- Add SQLite metadata for translated document variants.
- Add app-data paths for translated safe HTML.
- Add list/delete plumbing without model inference.
- Verify deleting a source document handles variants deliberately.

### Stage 4: Job Progress UI

- Add React API, hook, and minimal Translation panel.
- Display capabilities, model status, and fake/stub progress.
- Keep UI disabled when native translation is unavailable.

### Stage 5: CTranslate2 MVP

- Add native engine spike for one or two pair models.
- Implement model download/verify/install with checksum manifest.
- Translate bounded text segments.
- Emit progress events.
- Store translated output and index it.

### Stage 6: HTML/EPUB Preservation

- Preserve anchors, headings, footnotes, images, and document order.
- Add fixtures for footnotes, links, RTL text, mixed-language paragraphs, and tables.
- Add quality checks for broken links and empty output.

### Stage 7: Quality Upgrades

- Add glossary support.
- Add translation memory.
- Add named-entity consistency checks.
- Add section regeneration.
- Add optional chapter repair pass.

### Stage 8: Quality Model Spikes

- Evaluate TranslateGemma 4B/12B locally.
- Evaluate Qwen3 8B/14B for context-rich academic translation.
- Compare against CTranslate2 output on the same book samples.
- Decide which models belong in desktop, Android, or experimental catalogs.

### Stage 9: Mobile Hardening

- Benchmark memory, storage, speed, thermals, and battery.
- Limit model choices by platform capability.
- Add mobile-specific warnings and defaults.

## Manual Test Matrix

For every engine/model candidate:

- Short paragraph translation.
- Full chapter translation.
- Full long book translation.
- Resume after cancel.
- Resume after app restart.
- Delete translated variant.
- Re-run after source document delete.
- Search translated text.
- Generate TTS from translated text.
- Open original and translated variants independently.
- Verify internal links and footnotes still work.
- Verify RTL source documents and LTR translated output render correctly.
- Verify glossary term is used consistently.
- Verify repeated terms/names are stable across chapters.

Language samples:

- Arabic -> English: undiacritized prose with names, footnotes, and Quranic/classical terms if relevant.
- Chinese -> English: academic prose and names.
- Russian -> English: philosophy/political terminology.
- German -> English: compounds and long sentences.
- French/Spanish -> English: high-resource baseline quality.

## Open Questions

- Should translated variants appear under the original document as children, or as separate documents with a source badge?
- Should translated variants be exportable/importable as part of future library backup?
- Should glossary be global, per collection, or per document?
- Should the first quality model be TranslateGemma 4B or Qwen3 8B?
- Which CTranslate2 model pairs have acceptable licenses and quality for the first supported languages?
- Should Android support translation in the first release, or only after desktop benchmarks?

## References To Recheck Before Implementation

- CTranslate2: https://github.com/OpenNMT/CTranslate2
- CTranslate2 Transformers support: https://opennmt.net/CTranslate2/guides/transformers.html
- TranslateGemma model card: https://huggingface.co/google/translategemma-4b-it
- TranslateGemma announcement: https://blog.google/innovation-and-ai/technology/developers-tools/translategemma/
- Qwen3 8B model card: https://huggingface.co/Qwen/Qwen3-8B
- MADLAD-400 3B MT model card: https://huggingface.co/google/madlad400-3b-mt
- NLLB model card and limitations: https://huggingface.co/facebook/nllb-200-distilled-600M
- OPUS-MT example model card: https://huggingface.co/Helsinki-NLP/opus-mt-en-es
- Bergamot / Firefox Translations docs: https://firefox-source-docs.mozilla.org/toolkit/components/translations/resources/03_bergamot.html
- ALMA / X-ALMA repository: https://github.com/fe1ixxu/ALMA
