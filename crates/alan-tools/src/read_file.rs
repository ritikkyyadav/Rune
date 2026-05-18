use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs;
use std::path::{Path, PathBuf};

use crate::error::ToolError;

const MAX_FILE_SIZE: u64 = 10 * 1024 * 1024; // 10 MB
const DEFAULT_LINE_LIMIT: usize = 2000;

#[derive(Debug, Deserialize)]
pub struct ReadFileInput {
    pub path: String,
    pub offset: Option<usize>,
    pub limit: Option<usize>,
}

#[derive(Debug, Serialize)]
pub struct ReadFileOutput {
    pub path: String,
    pub content: String,
    pub hash: String,
    pub total_lines: usize,
    pub lines_shown: usize,
    pub offset: usize,
    pub truncated: bool,
}

pub fn execute(input: ReadFileInput, workspace_root: &Path) -> Result<ReadFileOutput, ToolError> {
    let resolved = resolve_path(&input.path, workspace_root)?;
    validate_within_workspace(&resolved, workspace_root)?;

    let metadata = fs::metadata(&resolved).map_err(|e| ToolError::Io {
        path: resolved.display().to_string(),
        detail: e.to_string(),
    })?;

    if metadata.len() > MAX_FILE_SIZE {
        return Err(ToolError::FileTooLarge {
            path: resolved.display().to_string(),
            size: metadata.len(),
            max: MAX_FILE_SIZE,
        });
    }

    let raw = fs::read(&resolved).map_err(|e| ToolError::Io {
        path: resolved.display().to_string(),
        detail: e.to_string(),
    })?;

    let hash = hex::encode(Sha256::digest(&raw));
    let content_str = String::from_utf8_lossy(&raw);
    let lines: Vec<&str> = content_str.lines().collect();
    let total_lines = lines.len();

    let offset = input.offset.unwrap_or(0);
    let limit = input.limit.unwrap_or(DEFAULT_LINE_LIMIT);

    let start = offset.min(total_lines);
    let end = (start + limit).min(total_lines);
    let shown_lines = &lines[start..end];
    let truncated = end < total_lines;

    // Format with line numbers
    let numbered: String = shown_lines
        .iter()
        .enumerate()
        .map(|(i, line)| format!("{:>6}\t{}", start + i + 1, line))
        .collect::<Vec<_>>()
        .join("\n");

    Ok(ReadFileOutput {
        path: resolved.display().to_string(),
        content: numbered,
        hash,
        total_lines,
        lines_shown: shown_lines.len(),
        offset: start,
        truncated,
    })
}

fn resolve_path(path: &str, workspace_root: &Path) -> Result<PathBuf, ToolError> {
    let p = Path::new(path);
    if p.is_absolute() {
        Ok(p.to_path_buf())
    } else {
        Ok(workspace_root.join(p))
    }
}

fn validate_within_workspace(path: &Path, workspace_root: &Path) -> Result<(), ToolError> {
    let canonical = fs::canonicalize(path).map_err(|e| ToolError::Io {
        path: path.display().to_string(),
        detail: e.to_string(),
    })?;
    let workspace_canonical =
        fs::canonicalize(workspace_root).map_err(|e| ToolError::Io {
            path: workspace_root.display().to_string(),
            detail: e.to_string(),
        })?;

    if !canonical.starts_with(&workspace_canonical) {
        return Err(ToolError::PathEscape {
            path: path.display().to_string(),
            workspace: workspace_root.display().to_string(),
        });
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    #[test]
    fn reads_file_with_line_numbers() {
        let tmp = TempDir::new().unwrap();
        let file = tmp.path().join("test.txt");
        fs::write(&file, "line1\nline2\nline3\n").unwrap();

        let output = execute(
            ReadFileInput {
                path: "test.txt".to_string(),
                offset: None,
                limit: None,
            },
            tmp.path(),
        )
        .unwrap();

        assert_eq!(output.total_lines, 3);
        assert_eq!(output.lines_shown, 3);
        assert!(!output.truncated);
        assert!(output.content.contains("     1\tline1"));
        assert!(!output.hash.is_empty());
    }

    #[test]
    fn respects_offset_and_limit() {
        let tmp = TempDir::new().unwrap();
        let file = tmp.path().join("big.txt");
        let content: String = (1..=100).map(|i| format!("line {i}\n")).collect();
        fs::write(&file, content).unwrap();

        let output = execute(
            ReadFileInput {
                path: "big.txt".to_string(),
                offset: Some(10),
                limit: Some(5),
            },
            tmp.path(),
        )
        .unwrap();

        assert_eq!(output.lines_shown, 5);
        assert_eq!(output.offset, 10);
        assert!(output.truncated);
        assert!(output.content.contains("    11\tline 11"));
    }

    #[test]
    fn rejects_path_escape() {
        let tmp = TempDir::new().unwrap();
        let outside = TempDir::new().unwrap();
        let file = outside.path().join("secret.txt");
        fs::write(&file, "secret").unwrap();

        let result = execute(
            ReadFileInput {
                path: file.display().to_string(),
                offset: None,
                limit: None,
            },
            tmp.path(),
        );

        assert!(matches!(result, Err(ToolError::PathEscape { .. })));
    }
}
