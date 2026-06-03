//! HTML format module: parsing + sanitization.
//!
//! This is the format-specific layer. Future PDF/EPUB support should add sibling
//! modules that emit the same normalized shape ([`ParsedHtmlDocument`] /
//! [`ParsedSection`]) so the store, search, and reader stay format-agnostic.

mod parser;
mod sanitize;

pub(crate) use parser::parse_html_document;

/// A parsed, sanitized document ready to store and index.
pub(crate) struct ParsedHtmlDocument {
    pub(crate) title: String,
    pub(crate) sanitized_html: String,
    pub(crate) sections: Vec<ParsedSection>,
}

/// One ordered readable section, optionally carrying the heading it falls under.
pub(crate) struct ParsedSection {
    pub(crate) heading: Option<String>,
    pub(crate) text: String,
}
