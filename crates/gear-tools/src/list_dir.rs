use globset::{Glob, GlobMatcher};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::Path;
use walkdir::WalkDir;

use crate::error::ToolError;

const DEFAULT_LIMIT: usize = 500;

#[derive(Debug, Deserialize)]
pub struct ListDirInput {
    pub path: String,
    pub recursive: Option<bool>,
    pub glob: Option<String>,
    pub limit: Option<usize>,
}

#[derive(Debug, Serialize)]
pub struct DirEntry {
    pub path: String,
    pub is_dir: bool,
    pub size: u64,
}

#[derive(Debug, Serialize)]
pub struct ListDirOutput {
    pub path: String,
    pub entries: Vec<DirEntry>,
    pub total_count: usize,
    pub truncated: bool,
}

pub fn execute(input: ListDirInput, workspace_root: &Path) -> Result<ListDirOutput, ToolError> {
    let resolved = if Path::new(&input.path).is_absolute() {
        Path::new(&input.path).to_path_buf()
    } else {
        workspace_root.join(&input.path)
    };

    let canonical = fs::canonicalize(&resolved).map_err(|e| ToolError::Io {
        path: resolved.display().to_string(),
        detail: e.to_string(),
    })?;

    let workspace_canonical = fs::canonicalize(workspace_root).map_err(|e| ToolError::Io {
        path: workspace_root.display().to_string(),
        detail: e.to_string(),
    })?;

    if !canonical.starts_with(&workspace_canonical) {
        return Err(ToolError::PathEscape {
            path: resolved.display().to_string(),
            workspace: workspace_root.display().to_string(),
        });
    }

    let recursive = input.recursive.unwrap_or(false);
    let limit = input.limit.unwrap_or(DEFAULT_LIMIT);

    let glob_matcher: Option<GlobMatcher> = input
        .glob
        .as_ref()
        .map(|g| {
            Glob::new(g)
                .map_err(|e| ToolError::InvalidArgs(format!("Invalid glob pattern: {e}")))
                .map(|g| g.compile_matcher())
        })
        .transpose()?;

    let max_depth = if recursive { usize::MAX } else { 1 };
    let walker = WalkDir::new(&canonical)
        .max_depth(max_depth)
        .sort_by_file_name();

    let mut entries = Vec::new();
    let mut total_count = 0;

    for entry in walker.into_iter().filter_map(|e| e.ok()) {
        // Skip the root directory itself
        if entry.path() == canonical {
            continue;
        }

        let rel_path = entry
            .path()
            .strip_prefix(&workspace_canonical)
            .unwrap_or(entry.path());

        // Apply glob filter
        if let Some(ref matcher) = glob_matcher
            && !matcher.is_match(rel_path)
        {
            continue;
        }

        total_count += 1;

        if entries.len() < limit {
            let metadata = entry.metadata().ok();
            entries.push(DirEntry {
                path: rel_path.display().to_string(),
                is_dir: entry.file_type().is_dir(),
                size: metadata.map(|m| m.len()).unwrap_or(0),
            });
        }
    }

    Ok(ListDirOutput {
        path: canonical.display().to_string(),
        entries,
        total_count,
        truncated: total_count > limit,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    #[test]
    fn lists_directory_non_recursive() {
        let tmp = TempDir::new().unwrap();
        fs::write(tmp.path().join("a.txt"), "").unwrap();
        fs::write(tmp.path().join("b.txt"), "").unwrap();
        fs::create_dir(tmp.path().join("sub")).unwrap();
        fs::write(tmp.path().join("sub/c.txt"), "").unwrap();

        let output = execute(
            ListDirInput {
                path: ".".to_string(),
                recursive: Some(false),
                glob: None,
                limit: None,
            },
            tmp.path(),
        )
        .unwrap();

        assert_eq!(output.total_count, 3); // a.txt, b.txt, sub/
        assert!(!output.truncated);
    }

    #[test]
    fn lists_directory_recursive() {
        let tmp = TempDir::new().unwrap();
        fs::write(tmp.path().join("a.txt"), "").unwrap();
        fs::create_dir(tmp.path().join("sub")).unwrap();
        fs::write(tmp.path().join("sub/b.txt"), "").unwrap();

        let output = execute(
            ListDirInput {
                path: ".".to_string(),
                recursive: Some(true),
                glob: None,
                limit: None,
            },
            tmp.path(),
        )
        .unwrap();

        assert_eq!(output.total_count, 3); // a.txt, sub/, sub/b.txt
    }

    #[test]
    fn respects_limit() {
        let tmp = TempDir::new().unwrap();
        for i in 0..20 {
            fs::write(tmp.path().join(format!("file{i:02}.txt")), "").unwrap();
        }

        let output = execute(
            ListDirInput {
                path: ".".to_string(),
                recursive: Some(false),
                glob: None,
                limit: Some(5),
            },
            tmp.path(),
        )
        .unwrap();

        assert_eq!(output.entries.len(), 5);
        assert_eq!(output.total_count, 20);
        assert!(output.truncated);
    }
}
