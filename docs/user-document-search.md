# User Document Uploads And Search Indexing

Papercut has two search-indexing paths on purpose:

- **Bundled documents** are known at build time and are indexed by Pagefind into the production frontend bundle.
- **User uploads** are unknown until runtime, so they are imported through Tauri and indexed into a local SQLite FTS5 database in app data.

This avoids the trap of trying to rebuild Pagefind on a user's device every time they add a document. Pagefind remains excellent for the shipped corpus, while SQLite FTS gives us incremental offline search for user-owned content.

## Current Scope

The first upload branch supports local HTML files:

- Users open **Import** from the document list and choose **HTML**.
- Tauri opens the native filesystem picker for `.html` and `.htm` files.
- Rust reads the selected file, enforces a 25 MB limit, requires UTF-8, sanitizes the HTML, extracts readable sections, stores the sanitized source, and indexes the sections into SQLite FTS5.
- React lists imported files under **User Uploads** and opens them with the same HTML reader path used by bundled documents.
- Search queries run through `src/hooks/useSearch.ts`, which queries Pagefind and SQLite FTS in parallel and returns one shared result shape.
- Users can delete uploaded HTML documents from the document list. Delete removes SQLite metadata, section rows, FTS rows, and the stored sanitized source directory.

This path is intentionally independent from `.papercut-audiobook` import/export. Audiobook bundle import remains TTS-specific, while generic document import is designed to be shippable as its own branch.

## Code Map

Frontend:

- `src/uploads/DocumentUploads.ts` is the small client API for user-upload commands and shared TypeScript types.
- `src/App.tsx` wires upload/search state into reusable hooks and components, and provides source loading for uploaded URLs.
- `src/components/DocumentsPanel/DocumentsPanel.tsx` owns the document dropdown UI, including the option-driven Import menu, Saved audio filtering, uploaded-document delete, and active filter chips. The HTML branch can pass only the HTML option; TTS branches can add the Audiobook option separately.
- `src/components/DocumentViewer/DocumentViewer.tsx` owns the reader shell, viewer plugin resolution, in-document Find, iframe sizing, scroll-to-top behavior, and the slots used by TTS controls/diagnostics.
- `src/hooks/useDocumentFilters.ts` owns document filter text, selected filters, author grouping, collapsed groups, and the optional inclusion predicate used by the Saved audio filter.
- `src/hooks/useSearch.ts` owns the combined Pagefind + SQLite query flow and maps uploaded matches into the shared `SearchResult` shape.

Rust:

- `src-tauri/src/document_uploads.rs` owns the runtime upload pipeline and SQLite database.
- `src-tauri/src/lib.rs` registers the Tauri commands exposed by the upload module.
- `src-tauri/Cargo.toml` includes `rusqlite` with the bundled SQLite feature so FTS5 support is available consistently across supported build targets.

Storage:

- Sanitized uploaded HTML is stored under Tauri app data at `document_uploads/{upload_id}/source.html`.
- The runtime search index lives at `document_uploads/search.sqlite3`.

## Import Pipeline

The runtime upload path follows a parser pipeline that can be reused for future formats:

1. **Pick file**: native Tauri dialog selects a local file.
2. **Validate input**: enforce size and encoding limits before parsing.
3. **Parse format**: HTML is parsed into a title and readable content blocks.
4. **Sanitize source**: remove active or risky HTML before storing/rendering it.
5. **Normalize sections**: convert the document into title + ordered text sections with optional headings.
6. **Store source**: save the sanitized viewable document to app data.
7. **Index sections**: write metadata and sections to SQLite, then populate the FTS5 table.
8. **Render/search**: React opens the stored source and searches through the same result-card UI as bundled docs.
9. **Delete**: when requested, Rust removes the document rows from SQLite and deletes the stored source directory from app data.

Future PDF and EPUB support should plug in at step 3 and output the same normalized section shape. That keeps upload UI, indexing, search results, and reader behavior shared.

## Search Flow

When a user submits a search:

1. React lowercases and normalizes the query.
2. Pagefind searches bundled build-time documents when the Pagefind index is available.
3. SQLite FTS5 searches uploaded runtime documents when the app is running in Tauri.
4. `useSearch` maps both providers into the existing `SearchResult` shape.
5. Uploaded section matches are collapsed to one result per uploaded document, keeping the first/best SQLite snippet for the document card.
6. Results are combined and rendered in the same panel.
7. If a result points to an uploaded document URL, source loading calls `document_uploads_get_source` instead of fetching from `dist/`.

SQLite FTS uses a Porter/unicode tokenizer with diacritic removal and BM25 ranking. Uploaded snippets are generated by SQLite and sanitized again in React before rendering, which keeps `<mark>` highlighting but prevents snippet HTML from becoming executable UI. Because the reader has its own in-document Find/highlight workflow, the search panel shows one uploaded-document card with the first relevant snippet instead of one card per matching section.

Exact quoted-phrase verification currently remains Pagefind-oriented because it fetches bundled source files and checks the normalized text manually. Uploaded documents already search through SQLite FTS, but exact phrase semantics should be tightened in a future pass if phrase search needs to behave identically across both providers.

## Performance Notes

SQLite FTS is a good fit for user uploads because it indexes incrementally. Importing one file touches one source file and one local database transaction; it does not regenerate the shipped corpus index.

For 500+ user documents, the important scaling rules are:

- Keep indexing per document incremental.
- Store text as sections/pages/chapters instead of one huge blob per document.
- Query only on explicit Search/Enter, not on every keystroke.
- Limit initial result counts and fetch/open full source only when the user chooses a document.
- Keep format parsing out of React so the WebView does not lock up on large imports.

This branch already follows those rules for HTML uploads. EPUB and PDF can stay lightweight if they produce section/page records and avoid rendering or indexing entire binary files in the frontend.

## Sanitization And Format Modules

Yes, upload formats should have separate sanitization/parser modules. HTML, PDF, and EPUB have different risks and extraction behavior:

- HTML needs active content stripping, URL cleanup, and safe stored rendering.
- PDF needs text-layer extraction, page boundaries, metadata extraction, and possibly OCR later.
- EPUB needs ZIP/container validation, OPF spine parsing, XHTML sanitization, and chapter ordering.

The shared output should be boring and stable:

`{ title, format, sanitizedSource?, sections: [{ ordinal, heading?, text, locator? }] }`

Keeping this shape stable lets the UI and SQLite indexing remain format-agnostic.

## Current Limitations

- Runtime import supports HTML only.
- HTML files must be UTF-8 and at most 25 MB.
- The current sanitizer is a conservative first pass, not a full standards-compliant HTML sanitizer.
- Uploaded-document search only runs inside the Tauri app, not plain browser preview.
- There is no user-facing reindex action for generic uploaded documents yet.
- Uploaded documents are not exported as part of a library backup yet.
- Quoted exact-phrase behavior is strongest for bundled Pagefind documents and should be unified with SQLite FTS later.

## Recommended Next Steps

1. Add a reindex action for uploaded documents if parser or sanitizer behavior changes after import.
2. Replace the lightweight Rust HTML sanitizer with a maintained sanitizer crate such as `ammonia`, if mobile/desktop build size and Android compatibility are acceptable.
3. Add an EPUB parser module that validates the ZIP, reads OPF metadata/spine order, sanitizes XHTML chapters, and indexes chapters as sections.
4. Add a runtime PDF import module that extracts page text and stores page records in the same SQLite schema.
5. Add duplicate detection based on source hash so repeated imports can update or skip existing records.
6. Add schema migrations with an explicit database version before changing table layout.
7. Add import progress reporting for very large EPUB/PDF files.
8. Decide whether Pagefind remains the bundled-document engine long term or whether all documents should eventually share SQLite FTS.
9. Add automated tests for parser output, sanitizer behavior, FTS query escaping, source retrieval, and delete cleanup.

## Branching Guidance

For the first shippable upload branch, keep the generic document work separate from TTS:

- Include `src/uploads/DocumentUploads.ts`.
- Include `src-tauri/src/document_uploads.rs` and the command registration in `src-tauri/src/lib.rs`.
- Include the `rusqlite` dependency.
- Include App UI changes for the **Import > HTML** option, **User Uploads**, uploaded-document delete, and merged search.
- Exclude `.papercut-audiobook` import/export work if you want a non-TTS branch.

That gives users HTML import and runtime search first. TTS bundle import can remain a later branch that reuses the same reader/playback surface once the document source exists in the app.
