use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use similar::{ChangeTag, TextDiff};
use std::fs;
use std::io::Write;
use std::path::Path;

use crate::error::ToolError;

#[derive(Debug, Deserialize)]
pub struct EditFileInput {
    pub path: String,
    pub old_text: String,
    pub new_text: String,
    pub expected_hash: String,
    pub replace_all: Option<bool>,
}

#[derive(Debug, Serialize)]
pub struct EditFileOutput {
    pub path: String,
    pub hash: String,
    pub diff: String,
    pub replacements: usize,
}

pub fn execute(input: EditFileInput, workspace_root: &Path) -> Result<EditFileOutput, ToolError> {
    let resolved = if Path::new(&input.path).is_absolute() {
        Path::new(&input.path).to_path_buf()
    } else {
        workspace_root.join(&input.path)
    };

    // Validate workspace containment
    let canonical = fs::canonicalize(&resolved).map_err(|e| ToolError::Io {
        path: resolved.display().to_string(),
        detail: e.to_string(),
    })?;
    let workspace_canonical =
        fs::canonicalize(workspace_root).map_err(|e| ToolError::Io {
            path: workspace_root.display().to_string(),
            detail: e.to_string(),
        })?;
    if !canonical.starts_with(&workspace_canonical) {
        return Err(ToolError::PathEscape {
            path: resolved.display().to_string(),
            workspace: workspace_root.display().to_string(),
        });
    }

    // Read current file
    let raw = fs::read(&canonical).map_err(|e| ToolError::Io {
        path: canonical.display().to_string(),
        detail: e.to_string(),
    })?;
    let current_hash = hex::encode(Sha256::digest(&raw));

    // Hash check — reject stale edits
    if current_hash != input.expected_hash {
        return Err(ToolError::InvalidArgs(format!(
            "Hash mismatch: file has changed since last read. Expected {}, got {}. Re-read the file first.",
            input.expected_hash, current_hash
        )));
    }

    let old_content = String::from_utf8_lossy(&raw).to_string();
    let replace_all = input.replace_all.unwrap_or(false);

    // Count matches
    let match_count = old_content.matches(&input.old_text).count();

    if match_count == 0 {
        return Err(ToolError::InvalidArgs(format!(
            "old_text not found in {}. The file may have changed or the text is incorrect.",
            input.path
        )));
    }

    // Uniqueness check — reject ambiguous edits unless replace_all
    if match_count > 1 && !replace_all {
        return Err(ToolError::InvalidArgs(format!(
            "old_text matches {} times in {}. Use replace_all=true or provide more context to make the match unique.",
            match_count, input.path
        )));
    }

    // Apply replacement
    let new_content = if replace_all {
        old_content.replace(&input.old_text, &input.new_text)
    } else {
        old_content.replacen(&input.old_text, &input.new_text, 1)
    };

    let replacements = if replace_all { match_count } else { 1 };

    // Generate unified diff
    let diff = generate_diff(&input.path, &old_content, &new_content);

    // Atomic write: temp → fsync → rename
    let dir = canonical.parent().unwrap_or(workspace_root);
    let mut tmp = tempfile::NamedTempFile::new_in(dir).map_err(|e| ToolError::Io {
        path: dir.display().to_string(),
        detail: format!("Failed to create temp file: {e}"),
    })?;

    let new_bytes = new_content.as_bytes();
    tmp.write_all(new_bytes).map_err(|e| ToolError::Io {
        path: canonical.display().to_string(),
        detail: format!("Write failed: {e}"),
    })?;

    tmp.as_file().sync_all().map_err(|e| ToolError::Io {
        path: canonical.display().to_string(),
        detail: format!("Fsync failed: {e}"),
    })?;

    tmp.persist(&canonical).map_err(|e| ToolError::Io {
        path: canonical.display().to_string(),
        detail: format!("Rename failed: {e}"),
    })?;

    let new_hash = hex::encode(Sha256::digest(new_bytes));

    Ok(EditFileOutput {
        path: canonical.display().to_string(),
        hash: new_hash,
        diff,
        replacements,
    })
}

fn generate_diff(path: &str, old: &str, new: &str) -> String {
    let diff = TextDiff::from_lines(old, new);
    let mut output = format!("--- a/{path}\n+++ b/{path}\n");

    for hunk in diff.unified_diff().context_radius(3).iter_hunks() {
        output.push_str(&hunk.header().to_string());
        for change in hunk.iter_changes() {
            let tag = match change.tag() {
                ChangeTag::Delete => "-",
                ChangeTag::Insert => "+",
                ChangeTag::Equal => " ",
            };
            output.push_str(&format!("{tag}{change}"));
        }
    }

    output
}

#[cfg(test)]
mod tests {
    use super::*;
    use sha2::{Digest, Sha256};
    use tempfile::TempDir;

    fn hash_of(content: &str) -> String {
        hex::encode(Sha256::digest(content.as_bytes()))
    }

    #[test]
    fn applies_single_edit() {
        let tmp = TempDir::new().unwrap();
        let content = "fn main() {\n    println!(\"hello\");\n}\n";
        fs::write(tmp.path().join("main.rs"), content).unwrap();

        let output = execute(
            EditFileInput {
                path: "main.rs".to_string(),
                old_text: "\"hello\"".to_string(),
                new_text: "\"world\"".to_string(),
                expected_hash: hash_of(content),
                replace_all: None,
            },
            tmp.path(),
        )
        .unwrap();

        assert_eq!(output.replacements, 1);
        let result = fs::read_to_string(tmp.path().join("main.rs")).unwrap();
        assert!(result.contains("\"world\""));
        assert!(!result.contains("\"hello\""));
        assert!(output.diff.contains("+"));
    }

    #[test]
    fn rejects_stale_hash() {
        let tmp = TempDir::new().unwrap();
        fs::write(tmp.path().join("file.txt"), "original").unwrap();

        let result = execute(
            EditFileInput {
                path: "file.txt".to_string(),
                old_text: "original".to_string(),
                new_text: "modified".to_string(),
                expected_hash: "wrong_hash".to_string(),
                replace_all: None,
            },
            tmp.path(),
        );

        assert!(matches!(result, Err(ToolError::InvalidArgs(msg)) if msg.contains("Hash mismatch")));
    }

    #[test]
    fn rejects_non_unique_match_without_replace_all() {
        let tmp = TempDir::new().unwrap();
        let content = "foo bar foo baz foo\n";
        fs::write(tmp.path().join("dups.txt"), content).unwrap();

        let result = execute(
            EditFileInput {
                path: "dups.txt".to_string(),
                old_text: "foo".to_string(),
                new_text: "qux".to_string(),
                expected_hash: hash_of(content),
                replace_all: None,
            },
            tmp.path(),
        );

        assert!(matches!(result, Err(ToolError::InvalidArgs(msg)) if msg.contains("3 times")));
    }

    #[test]
    fn replace_all_works() {
        let tmp = TempDir::new().unwrap();
        let content = "foo bar foo baz foo\n";
        fs::write(tmp.path().join("dups.txt"), content).unwrap();

        let output = execute(
            EditFileInput {
                path: "dups.txt".to_string(),
                old_text: "foo".to_string(),
                new_text: "qux".to_string(),
                expected_hash: hash_of(content),
                replace_all: Some(true),
            },
            tmp.path(),
        )
        .unwrap();

        assert_eq!(output.replacements, 3);
        let result = fs::read_to_string(tmp.path().join("dups.txt")).unwrap();
        assert_eq!(result, "qux bar qux baz qux\n");
    }

    #[test]
    fn rejects_old_text_not_found() {
        let tmp = TempDir::new().unwrap();
        let content = "actual content\n";
        fs::write(tmp.path().join("file.txt"), content).unwrap();

        let result = execute(
            EditFileInput {
                path: "file.txt".to_string(),
                old_text: "does not exist".to_string(),
                new_text: "replacement".to_string(),
                expected_hash: hash_of(content),
                replace_all: None,
            },
            tmp.path(),
        );

        assert!(matches!(result, Err(ToolError::InvalidArgs(msg)) if msg.contains("not found")));
    }

    #[test]
    fn generates_valid_diff() {
        let tmp = TempDir::new().unwrap();
        let content = "line1\nline2\nline3\nline4\n";
        fs::write(tmp.path().join("diff.txt"), content).unwrap();

        let output = execute(
            EditFileInput {
                path: "diff.txt".to_string(),
                old_text: "line2".to_string(),
                new_text: "LINE_TWO".to_string(),
                expected_hash: hash_of(content),
                replace_all: None,
            },
            tmp.path(),
        )
        .unwrap();

        assert!(output.diff.contains("--- a/diff.txt"));
        assert!(output.diff.contains("+++ b/diff.txt"));
        assert!(output.diff.contains("-line2"));
        assert!(output.diff.contains("+LINE_TWO"));
    }
}
