use std::path::Path;
use std::time::Instant;

use rune_index::{CodeSearch, SearchHit};
use serde::{Deserialize, Serialize};

use crate::error::ToolError;

#[derive(Debug, Deserialize)]
pub struct SearchCodeInput {
    /// Natural-language or keyword query, e.g. "where are stripe webhook retries handled".
    pub query: String,
    /// Maximum number of results (default 10, capped at 50).
    pub limit: Option<u32>,
}

#[derive(Debug, Serialize)]
pub struct SearchCodeOutput {
    pub hits: Vec<SearchHit>,
    pub total: usize,
    /// Files (re)indexed by the incremental refresh that ran before searching.
    pub files_indexed: usize,
    pub refresh_ms: u64,
}

/// Ranked BM25 search over symbol chunks. The index lives at
/// `.rune/search.db` and refreshes incrementally on every call — an unchanged
/// tree costs one stat pass (well under the 500ms budget), so results are
/// never stale and no background watcher is needed.
pub fn execute(input: SearchCodeInput, workspace: &Path) -> Result<SearchCodeOutput, ToolError> {
    if input.query.trim().is_empty() {
        return Err(ToolError::InvalidArgs(
            "query must not be empty".to_string(),
        ));
    }
    let limit = input.limit.unwrap_or(10).clamp(1, 50) as usize;

    let db_path = workspace.join(".rune").join("search.db");
    let mut search = CodeSearch::open(&db_path)
        .map_err(|e| ToolError::CommandFailed(format!("open search index: {e}")))?;

    let started = Instant::now();
    let refresh = search
        .refresh(workspace)
        .map_err(|e| ToolError::CommandFailed(format!("index refresh failed: {e}")))?;
    let refresh_ms = started.elapsed().as_millis() as u64;

    let hits = search
        .search(&input.query, limit)
        .map_err(|e| ToolError::CommandFailed(format!("search failed: {e}")))?;

    Ok(SearchCodeOutput {
        total: hits.len(),
        hits,
        files_indexed: refresh.files_indexed,
        refresh_ms,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn end_to_end_relevance_over_a_fixture_workspace() {
        let tmp = TempDir::new().unwrap();
        std::fs::create_dir_all(tmp.path().join("src")).unwrap();
        std::fs::write(
            tmp.path().join("src/billing.py"),
            "def retry_failed_invoice_charge(invoice):\n    \"\"\"Retries a failed charge with backoff.\"\"\"\n    return schedule(invoice)\n",
        )
        .unwrap();
        std::fs::write(
            tmp.path().join("src/auth.py"),
            "def login(user):\n    return session(user)\n",
        )
        .unwrap();

        let out = execute(
            SearchCodeInput {
                query: "retry failed charges".to_string(),
                limit: None,
            },
            tmp.path(),
        )
        .unwrap();
        assert!(out.total >= 1);
        assert_eq!(out.hits[0].symbol, "retry_failed_invoice_charge");
        assert!(out.hits[0].path.ends_with("billing.py"));

        // Second call over an unchanged tree re-indexes nothing.
        let again = execute(
            SearchCodeInput {
                query: "retry failed charges".to_string(),
                limit: None,
            },
            tmp.path(),
        )
        .unwrap();
        assert_eq!(again.files_indexed, 0);
    }

    #[test]
    fn empty_query_is_invalid() {
        let tmp = TempDir::new().unwrap();
        let err = execute(
            SearchCodeInput {
                query: "   ".to_string(),
                limit: None,
            },
            tmp.path(),
        );
        assert!(err.is_err());
    }
}
