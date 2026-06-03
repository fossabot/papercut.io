//! Runtime user-document upload feature.
//!
//! Splits the upload pipeline into focused submodules so each concern can grow
//! independently. Dependencies only point downward:
//!
//! ```text
//! commands -> pipeline -> { html, store, search, storage } -> types
//! ```
//!
//! - [`commands`]: the thin `#[tauri::command]` edge exposed to the frontend.
//! - [`pipeline`]: orchestrates import / get-source / delete.
//! - [`html`]: format-specific parsing + sanitization (PDF/EPUB plug in here).
//! - [`store`]: SQLite schema, persistence, and listing.
//! - [`search`]: FTS5 query building and execution.
//! - [`storage`]: filesystem paths, upload ids, size accounting, clock.
//! - [`types`]: serde DTOs shared across the boundary.

// `commands` is `pub(crate)` so `generate_handler!` in `lib.rs` can reach both
// each command and the hidden `__cmd__*` helper the macro generates beside it.
pub(crate) mod commands;
mod html;
mod pipeline;
mod search;
mod storage;
mod store;
mod types;
