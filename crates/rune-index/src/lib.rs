//! Code indexing and symbol retrieval for the Rune agentic coding assistant.
//!
//! Provides symbol extraction and structural repository maps across multiple
//! languages, backed by a SQLite store for fast symbol lookup and staleness
//! checks.

pub mod error;
pub mod index;
pub mod languages;
pub mod query;
pub mod repo_map;
pub mod search;
pub mod store;

pub use error::IndexError;
pub use index::{IndexSummary, Indexer};
pub use languages::{Language, detect_language};
pub use query::{IndexStats, IndexedFile, Symbol, SymbolKind, SymbolQuery};
pub use repo_map::{RepoMapConfig, RepoMapOutput, build_repo_map};
pub use search::{CodeSearch, RefreshSummary, SearchHit};
pub use store::SymbolStore;
