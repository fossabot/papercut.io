//! Audiobook export/import bundle format, plus saved-audiobook deletion.
//!
//! A `.papercut-audiobook` bundle is a single self-describing file:
//!
//! ```text
//! [ BUNDLE_MAGIC bytes ][ u64 manifest length ][ JSON manifest ][ payloads... ]
//! ```
//!
//! The JSON manifest lists every packed file with its byte length and offset;
//! the payloads are just those files concatenated in offset order. This mirrors
//! a tar/zip idea but stays trivially streamable.
//!
//! Submodules split the two directions plus housekeeping:
//!
//! - [`export`]: stitch saved chunk WAVs into one track and pack the bundle.
//! - [`import`]: parse/validate a bundle and restore it into app data.
//! - [`manage`]: read an imported document's source HTML and delete saved audio.

mod export;
mod import;
mod manage;

pub(crate) use export::export_audiobook_native;
pub(crate) use import::import_audiobook_native;
pub(crate) use manage::{delete_audiobook_native, get_imported_audiobook_source};
