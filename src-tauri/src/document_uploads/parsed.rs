//! Format-neutral parsed document shape used by upload parsers, storage, search,
//! and TTS-facing source retrieval.

/// A parsed, sanitized document ready to store and index.
pub(crate) struct ParsedDocument {
    pub(crate) title: String,
    pub(crate) format: String,
    pub(crate) view_html: String,
    pub(crate) sections: Vec<ParsedSection>,
}

/// One ordered readable section, optionally carrying the heading it falls under.
pub(crate) struct ParsedSection {
    pub(crate) heading: Option<String>,
    pub(crate) text: String,
}
