//! Code indexing and symbol retrieval for the Alan agentic coding assistant.
//!
//! Provides regex-based symbol extraction across multiple languages,
//! backed by a SQLite store for fast symbol lookup and staleness checks.

pub mod error;
pub mod index;
pub mod languages;
pub mod query;
pub mod store;

pub use error::IndexError;
pub use index::{IndexSummary, Indexer};
pub use languages::{Language, detect_language};
pub use query::{IndexStats, IndexedFile, Symbol, SymbolKind, SymbolQuery};
pub use store::SymbolStore;
