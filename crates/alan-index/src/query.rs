use serde::{Deserialize, Serialize};

/// Describes the kind of symbol extracted from source code.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SymbolKind {
    Function,
    Method,
    Class,
    Struct,
    Enum,
    Trait,
    Interface,
    Type,
    Constant,
    Impl,
}

impl SymbolKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Function => "function",
            Self::Method => "method",
            Self::Class => "class",
            Self::Struct => "struct",
            Self::Enum => "enum",
            Self::Trait => "trait",
            Self::Interface => "interface",
            Self::Type => "type",
            Self::Constant => "constant",
            Self::Impl => "impl",
        }
    }

    pub fn from_str_lossy(s: &str) -> Option<Self> {
        match s {
            "function" => Some(Self::Function),
            "method" => Some(Self::Method),
            "class" => Some(Self::Class),
            "struct" => Some(Self::Struct),
            "enum" => Some(Self::Enum),
            "trait" => Some(Self::Trait),
            "interface" => Some(Self::Interface),
            "type" => Some(Self::Type),
            "constant" => Some(Self::Constant),
            "impl" => Some(Self::Impl),
            _ => None,
        }
    }
}

/// A query to search for symbols in the index.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct SymbolQuery {
    /// Name pattern to match (substring match).
    pub name: Option<String>,
    /// Filter to a specific symbol kind.
    pub kind: Option<SymbolKind>,
    /// Glob pattern to filter by file path.
    pub file_glob: Option<String>,
    /// Maximum number of results to return.
    pub limit: Option<u32>,
}

/// A symbol extracted from a source file.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Symbol {
    pub id: Option<i64>,
    pub file_id: i64,
    pub name: String,
    pub kind: SymbolKind,
    pub start_line: u32,
    pub end_line: u32,
    pub signature: Option<String>,
    pub doc_comment: Option<String>,
    pub parent_id: Option<i64>,
}

/// Metadata about an indexed file.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IndexedFile {
    pub id: i64,
    pub path: String,
    pub hash: String,
    pub language: String,
    pub indexed_at: String,
    pub symbol_count: u32,
}

/// Summary statistics for the entire index.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IndexStats {
    pub total_files: u64,
    pub total_symbols: u64,
    pub languages: Vec<(String, u64)>,
}
