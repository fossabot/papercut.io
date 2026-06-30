//! Shared HTML parsing helpers for translation.
//!
//! Kuchikiki's parser returns a sink wrapper whose `document_node` is the DOM
//! most translation code wants to work with. Keeping that detail here lets the
//! renderer and quality gates accept `NodeRef` consistently instead of leaking
//! parser internals into every call site.

use kuchikiki::{parse_html, traits::TendrilSink, NodeRef};

/// Parse reader/generated HTML into the document node used by DOM transforms.
pub(crate) fn parse_html_document(html: impl Into<String>) -> NodeRef {
    parse_html().one(html.into()).document_node
}
