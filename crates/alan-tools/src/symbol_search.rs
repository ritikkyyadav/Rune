use std::path::Path;

use alan_index::{Indexer, SymbolKind, SymbolQuery, SymbolStore};
use serde::{Deserialize, Serialize};

use crate::error::ToolError;

#[derive(Debug, Deserialize)]
pub struct SymbolSearchInput {
    /// Name pattern to search for (substring match).
    pub query: String,
    /// Filter by symbol kind: function, method, class, struct, enum, trait, interface, type, constant, impl.
    pub kind: Option<String>,
    /// Glob pattern to filter by file path (e.g. "src/**/*.rs").
    pub file_glob: Option<String>,
    /// Maximum number of results (default 25).
    pub limit: Option<u32>,
    /// If true, re-index the workspace before searching. Default false.
    pub reindex: Option<bool>,
}

#[derive(Debug, Serialize)]
pub struct SymbolSearchOutput {
    pub symbols: Vec<SymbolHit>,
    pub total: usize,
    pub index_stats: IndexStatsOutput,
}

#[derive(Debug, Serialize)]
pub struct SymbolHit {
    pub name: String,
    pub kind: String,
    pub file: String,
    pub start_line: u32,
    pub end_line: u32,
    pub signature: Option<String>,
    pub doc_comment: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct IndexStatsOutput {
    pub total_files: u64,
    pub total_symbols: u64,
}

pub fn execute(input: SymbolSearchInput, workspace: &Path) -> Result<SymbolSearchOutput, ToolError> {
    let db_path = workspace.join(".alan").join("symbols.db");

    // Ensure .alan directory exists
    if let Some(parent) = db_path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| ToolError::CommandFailed(e.to_string()))?;
    }

    let store = SymbolStore::open(&db_path)
        .map_err(|e| ToolError::CommandFailed(format!("Failed to open symbol store: {e}")))?;

    // Re-index if requested or if the store is empty
    let stats = store
        .stats()
        .map_err(|e| ToolError::CommandFailed(format!("Failed to get stats: {e}")))?;

    if input.reindex.unwrap_or(false) || stats.total_files == 0 {
        let mut indexer = Indexer::new(workspace, store)
            .map_err(|e| ToolError::CommandFailed(format!("Failed to create indexer: {e}")))?;
        indexer
            .index_directory()
            .map_err(|e| ToolError::CommandFailed(format!("Indexing failed: {e}")))?;

        return search_symbols(indexer.store(), &input, workspace);
    }

    search_symbols(&store, &input, workspace)
}

fn search_symbols(
    store: &SymbolStore,
    input: &SymbolSearchInput,
    workspace: &Path,
) -> Result<SymbolSearchOutput, ToolError> {
    let kind = input
        .kind
        .as_deref()
        .and_then(SymbolKind::from_str_lossy);

    let query = SymbolQuery {
        name: Some(input.query.clone()),
        kind,
        file_glob: input.file_glob.clone(),
        limit: Some(input.limit.unwrap_or(25)),
    };

    let symbols = store
        .find_symbols(&query)
        .map_err(|e| ToolError::CommandFailed(format!("Query failed: {e}")))?;

    let total = symbols.len();

    let hits: Vec<SymbolHit> = symbols
        .into_iter()
        .filter_map(|sym| {
            let file_path = store
                .get_file_path_by_id(sym.file_id)
                .ok()
                .flatten()?;
            // Make path relative to workspace
            let file = Path::new(&file_path)
                .strip_prefix(workspace)
                .map(|p| p.display().to_string())
                .unwrap_or(file_path);
            Some(SymbolHit {
                name: sym.name,
                kind: sym.kind.as_str().to_string(),
                file,
                start_line: sym.start_line,
                end_line: sym.end_line,
                signature: sym.signature,
                doc_comment: sym.doc_comment,
            })
        })
        .collect();

    let stats = store
        .stats()
        .map_err(|e| ToolError::CommandFailed(format!("Stats failed: {e}")))?;

    Ok(SymbolSearchOutput {
        symbols: hits,
        total,
        index_stats: IndexStatsOutput {
            total_files: stats.total_files,
            total_symbols: stats.total_symbols,
        },
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn search_empty_workspace() {
        let tmp = TempDir::new().unwrap();
        let input = SymbolSearchInput {
            query: "main".to_string(),
            kind: None,
            file_glob: None,
            limit: None,
            reindex: Some(true),
        };
        let result = execute(input, tmp.path()).unwrap();
        assert_eq!(result.total, 0);
    }

    #[test]
    fn search_finds_function() {
        let tmp = TempDir::new().unwrap();
        let src_dir = tmp.path().join("src");
        std::fs::create_dir_all(&src_dir).unwrap();
        std::fs::write(
            src_dir.join("main.rs"),
            "fn hello_world() {\n    println!(\"hello\");\n}\n",
        )
        .unwrap();

        let input = SymbolSearchInput {
            query: "hello".to_string(),
            kind: Some("function".to_string()),
            file_glob: None,
            limit: None,
            reindex: Some(true),
        };
        let result = execute(input, tmp.path()).unwrap();
        assert_eq!(result.total, 1);
        assert_eq!(result.symbols[0].name, "hello_world");
        assert_eq!(result.symbols[0].kind, "function");
    }
}
