use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs;
use std::io::Write;
use std::path::Path;

use crate::error::ToolError;

#[derive(Debug, Deserialize)]
pub struct WriteFileInput {
    pub path: String,
    pub content: String,
}

#[derive(Debug, Serialize)]
pub struct WriteFileOutput {
    pub path: String,
    pub hash: String,
    pub bytes_written: usize,
    pub created: bool,
}

pub fn execute(input: WriteFileInput, workspace_root: &Path) -> Result<WriteFileOutput, ToolError> {
    let resolved = if Path::new(&input.path).is_absolute() {
        Path::new(&input.path).to_path_buf()
    } else {
        workspace_root.join(&input.path)
    };

    // Validate workspace containment (parent must exist and be within workspace)
    if let Some(parent) = resolved.parent() {
        let workspace_canonical = fs::canonicalize(workspace_root).map_err(|e| ToolError::Io {
            path: workspace_root.display().to_string(),
            detail: e.to_string(),
        })?;

        // Parent might not exist yet; check the closest existing ancestor
        let mut check_path = parent.to_path_buf();
        while !check_path.exists() {
            match check_path.parent() {
                Some(p) => check_path = p.to_path_buf(),
                None => break,
            }
        }
        if check_path.exists() {
            let canonical_check = fs::canonicalize(&check_path).map_err(|e| ToolError::Io {
                path: check_path.display().to_string(),
                detail: e.to_string(),
            })?;
            if !canonical_check.starts_with(&workspace_canonical) {
                return Err(ToolError::PathEscape {
                    path: resolved.display().to_string(),
                    workspace: workspace_root.display().to_string(),
                });
            }
        }
    }

    let created = !resolved.exists();

    // Ensure parent directories exist
    if let Some(parent) = resolved.parent() {
        fs::create_dir_all(parent).map_err(|e| ToolError::Io {
            path: parent.display().to_string(),
            detail: e.to_string(),
        })?;
    }

    // Atomic write: temp file in same directory → fsync → rename
    let dir = resolved.parent().unwrap_or(workspace_root);
    let mut tmp = tempfile::NamedTempFile::new_in(dir).map_err(|e| ToolError::Io {
        path: dir.display().to_string(),
        detail: format!("Failed to create temp file: {e}"),
    })?;

    let bytes = input.content.as_bytes();
    tmp.write_all(bytes).map_err(|e| ToolError::Io {
        path: resolved.display().to_string(),
        detail: format!("Write failed: {e}"),
    })?;

    tmp.as_file().sync_all().map_err(|e| ToolError::Io {
        path: resolved.display().to_string(),
        detail: format!("Fsync failed: {e}"),
    })?;

    tmp.persist(&resolved).map_err(|e| ToolError::Io {
        path: resolved.display().to_string(),
        detail: format!("Rename failed: {e}"),
    })?;

    let hash = hex::encode(Sha256::digest(bytes));

    Ok(WriteFileOutput {
        path: resolved.display().to_string(),
        hash,
        bytes_written: bytes.len(),
        created,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn creates_new_file() {
        let tmp = TempDir::new().unwrap();
        let output = execute(
            WriteFileInput {
                path: "new.txt".to_string(),
                content: "hello world\n".to_string(),
            },
            tmp.path(),
        )
        .unwrap();

        assert!(output.created);
        assert_eq!(output.bytes_written, 12);
        assert!(!output.hash.is_empty());
        assert_eq!(
            fs::read_to_string(tmp.path().join("new.txt")).unwrap(),
            "hello world\n"
        );
    }

    #[test]
    fn overwrites_existing_file() {
        let tmp = TempDir::new().unwrap();
        fs::write(tmp.path().join("existing.txt"), "old content").unwrap();

        let output = execute(
            WriteFileInput {
                path: "existing.txt".to_string(),
                content: "new content".to_string(),
            },
            tmp.path(),
        )
        .unwrap();

        assert!(!output.created);
        assert_eq!(
            fs::read_to_string(tmp.path().join("existing.txt")).unwrap(),
            "new content"
        );
    }

    #[test]
    fn creates_parent_directories() {
        let tmp = TempDir::new().unwrap();
        let output = execute(
            WriteFileInput {
                path: "deep/nested/dir/file.txt".to_string(),
                content: "deep\n".to_string(),
            },
            tmp.path(),
        )
        .unwrap();

        assert!(output.created);
        assert!(tmp.path().join("deep/nested/dir/file.txt").exists());
    }

    #[test]
    fn rejects_path_outside_workspace() {
        let tmp = TempDir::new().unwrap();
        let outside = TempDir::new().unwrap();

        let result = execute(
            WriteFileInput {
                path: outside.path().join("evil.txt").display().to_string(),
                content: "evil".to_string(),
            },
            tmp.path(),
        );

        assert!(matches!(result, Err(ToolError::PathEscape { .. })));
    }
}
