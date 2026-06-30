//! Offline document translation feature skeleton.
//!
//! Translation is intentionally separate from `document_uploads` and
//! `native_tts`: upload parsers keep producing safe source + section records,
//! while this feature will consume that stable contract and create translated
//! document variants. The initial module only exposes typed unavailable
//! capabilities so frontend work can integrate against stable command names
//! before any native translation engine is chosen.

pub(crate) mod commands;
mod config;
mod models;
mod stub;
mod types;
