use std::path::Path;

use gear_index::{RepoMapConfig, RepoMapOutput, build_repo_map};
use serde::Deserialize;

use crate::error::ToolError;

/// Input accepted by `gear-tools repo-map`. The command is deliberately not a
/// model-facing tool: the orchestrator invokes it once per user request and
/// puts the bounded result through the normal context budgeter.
#[derive(Debug, Deserialize)]
pub struct RepoMapInput {
    #[serde(default)]
    pub query: String,
    pub max_tokens: Option<u32>,
    pub max_files: Option<u32>,
    pub max_symbols: Option<u32>,
}

pub fn execute(input: RepoMapInput, workspace: &Path) -> Result<RepoMapOutput, ToolError> {
    let config = RepoMapConfig {
        query: input.query,
        max_tokens: input
            .max_tokens
            .map(usize::try_from)
            .transpose()
            .map_err(|error| {
                ToolError::InvalidArgs(format!("max_tokens is out of range: {error}"))
            })?
            .unwrap_or_default(),
        max_files: input
            .max_files
            .map(usize::try_from)
            .transpose()
            .map_err(|error| ToolError::InvalidArgs(format!("max_files is out of range: {error}")))?
            .unwrap_or_default(),
        max_symbols: input
            .max_symbols
            .map(usize::try_from)
            .transpose()
            .map_err(|error| {
                ToolError::InvalidArgs(format!("max_symbols is out of range: {error}"))
            })?
            .unwrap_or_default(),
    };
    build_repo_map(workspace, config)
        .map_err(|error| ToolError::CommandFailed(format!("repo-map indexing failed: {error}")))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn returns_serializable_bounded_map() {
        let temp = TempDir::new().unwrap();
        std::fs::write(
            temp.path().join("main.py"),
            "def hello():\n    return 'hi'\n",
        )
        .unwrap();
        let result = execute(
            RepoMapInput {
                query: "hello".to_string(),
                max_tokens: Some(128),
                max_files: None,
                max_symbols: None,
            },
            temp.path(),
        )
        .unwrap();
        assert!(result.content.contains("hello"));
        assert!(result.estimated_tokens <= 128);
        assert!(
            serde_json::to_string(&result)
                .unwrap()
                .contains("estimated_tokens")
        );
    }
}
