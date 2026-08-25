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
    /// Which matching tier produced the edit: "exact", "whitespace", or "indentation".
    pub strategy: String,
}

/// The matching tier that located `old_text` within the file.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum MatchStrategy {
    /// Tier 1: exact substring match.
    Exact,
    /// Tier 2: line-based, each line right-trimmed (trailing spaces/tabs/\r stripped).
    Whitespace,
    /// Tier 3: line-based, each line fully trimmed (leading + trailing whitespace).
    Indentation,
}

impl MatchStrategy {
    fn as_str(self) -> &'static str {
        match self {
            MatchStrategy::Exact => "exact",
            MatchStrategy::Whitespace => "whitespace",
            MatchStrategy::Indentation => "indentation",
        }
    }
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

    // Locate and apply the edit using the 3-tier matching strategy. Falls back
    // from exact substring -> whitespace-insensitive -> indentation-insensitive,
    // but only when the match is unambiguous (otherwise it errors instead of guessing).
    let Edit {
        content: new_content,
        replacements,
        strategy,
    } = apply_edit(
        &old_content,
        &input.old_text,
        &input.new_text,
        replace_all,
        &input.path,
    )?;

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
        strategy: strategy.as_str().to_string(),
    })
}

/// Result of a successful 3-tier match + replace.
struct Edit {
    content: String,
    replacements: usize,
    strategy: MatchStrategy,
}

/// Apply a single find-and-replace using the 3-tier matching strategy, mirroring
/// the semantics of `packages/tool-registry/src/tools/multi-edit.ts`.
///
/// - Tier 1 (exact): exact substring match. With `replace_all`, replaces every
///   occurrence; otherwise requires exactly one (errors if >1, falls through if 0).
/// - Tier 2 (whitespace): line-based, each line right-trimmed (trailing spaces,
///   tabs, and `\r` stripped) before comparison. Same uniqueness rules.
/// - Tier 3 (indentation): line-based, each line fully trimmed. Same uniqueness rules.
///
/// On a line-window match, the original file lines are replaced with `new_text`
/// split into lines.
fn apply_edit(
    content: &str,
    old_text: &str,
    new_text: &str,
    replace_all: bool,
    path: &str,
) -> Result<Edit, ToolError> {
    // ── Tier 1: exact substring ──
    let exact = content.matches(old_text).count();
    if exact > 0 {
        if !replace_all && exact > 1 {
            return Err(ToolError::InvalidArgs(format!(
                "old_text matches {exact} times in {path}. \
                 Use replace_all=true or provide more context to make the match unique."
            )));
        }
        let new_content = if replace_all {
            content.replace(old_text, new_text)
        } else {
            content.replacen(old_text, new_text, 1)
        };
        return Ok(Edit {
            content: new_content,
            replacements: if replace_all { exact } else { 1 },
            strategy: MatchStrategy::Exact,
        });
    }

    // ── Tiers 2 & 3: line-based normalized matching ──
    let lines: Vec<&str> = content.split('\n').collect();
    let old_lines: Vec<&str> = old_text.split('\n').collect();
    let new_lines: Vec<&str> = new_text.split('\n').collect();

    type NormalizeFn = fn(&str) -> &str;
    let tiers: [(MatchStrategy, NormalizeFn); 2] = [
        (MatchStrategy::Whitespace, rtrim),
        (MatchStrategy::Indentation, str::trim),
    ];

    for (strategy, norm) in tiers {
        let norm_old: Vec<&str> = old_lines.iter().map(|l| norm(l)).collect();
        let starts = locate_windows(&lines, &norm_old, norm);
        if starts.is_empty() {
            continue;
        }
        if !replace_all && starts.len() > 1 {
            return Err(ToolError::InvalidArgs(format!(
                "old_text matches {} times in {} after {}-insensitive matching. \
                 Use replace_all=true or provide more context to make the match unique.",
                starts.len(),
                path,
                strategy.as_str(),
            )));
        }
        let targets: &[usize] = if replace_all { &starts } else { &starts[..1] };
        let out = splice_windows(&lines, targets, old_lines.len(), &new_lines);
        return Ok(Edit {
            content: out.join("\n"),
            replacements: targets.len(),
            strategy,
        });
    }

    Err(ToolError::InvalidArgs(format!(
        "old_text not found in {path} \
         (tried exact, whitespace-insensitive, and indentation-insensitive matching). \
         The file may have changed or the text is incorrect."
    )))
}

/// Right-trim: strip trailing spaces, tabs, and carriage returns (matches the
/// `/[ \t\r]+$/` regex used in the TypeScript implementation).
fn rtrim(s: &str) -> &str {
    s.trim_end_matches([' ', '\t', '\r'])
}

/// Return the non-overlapping start indices of every line-window in `lines`
/// that matches `norm_old` once each line is run through `norm`.
fn locate_windows(lines: &[&str], norm_old: &[&str], norm: fn(&str) -> &str) -> Vec<usize> {
    let mut starts = Vec::new();
    if norm_old.is_empty() || norm_old.len() > lines.len() {
        return starts;
    }
    let mut i = 0;
    while i + norm_old.len() <= lines.len() {
        let matched = norm_old
            .iter()
            .enumerate()
            .all(|(j, expected)| norm(lines[i + j]) == *expected);
        if matched {
            starts.push(i);
            i += norm_old.len(); // non-overlapping
        } else {
            i += 1;
        }
    }
    starts
}

/// Replace each line-window beginning at one of `starts` (each `old_len` lines
/// long) with `new_lines`, leaving all other lines untouched.
fn splice_windows(
    lines: &[&str],
    starts: &[usize],
    old_len: usize,
    new_lines: &[&str],
) -> Vec<String> {
    let start_set: std::collections::HashSet<usize> = starts.iter().copied().collect();
    let mut out: Vec<String> = Vec::new();
    let mut i = 0;
    while i < lines.len() {
        if start_set.contains(&i) {
            out.extend(new_lines.iter().map(|s| s.to_string()));
            i += old_len;
        } else {
            out.push(lines[i].to_string());
            i += 1;
        }
    }
    out
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

        assert!(
            matches!(result, Err(ToolError::InvalidArgs(msg)) if msg.contains("Hash mismatch"))
        );
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

    #[test]
    fn exact_match_reports_exact_strategy() {
        let tmp = TempDir::new().unwrap();
        let content = "alpha\nbeta\ngamma\n";
        fs::write(tmp.path().join("f.txt"), content).unwrap();

        let output = execute(
            EditFileInput {
                path: "f.txt".to_string(),
                old_text: "beta".to_string(),
                new_text: "BETA".to_string(),
                expected_hash: hash_of(content),
                replace_all: None,
            },
            tmp.path(),
        )
        .unwrap();

        assert_eq!(output.strategy, "exact");
        assert_eq!(output.replacements, 1);
    }

    #[test]
    fn whitespace_fallback_matches_on_trailing_whitespace_drift() {
        let tmp = TempDir::new().unwrap();
        // File has trailing spaces/tabs the model didn't reproduce.
        let content = "fn main() {  \n    let x = 1;\t\n}\n";
        fs::write(tmp.path().join("ws.rs"), content).unwrap();

        // old_text has clean line endings (no trailing whitespace), so exact
        // substring match fails and tier 2 (right-trim) must kick in.
        let output = execute(
            EditFileInput {
                path: "ws.rs".to_string(),
                old_text: "fn main() {\n    let x = 1;\n}".to_string(),
                new_text: "fn main() {\n    let x = 2;\n}".to_string(),
                expected_hash: hash_of(content),
                replace_all: None,
            },
            tmp.path(),
        )
        .unwrap();

        assert_eq!(output.strategy, "whitespace");
        assert_eq!(output.replacements, 1);
        let result = fs::read_to_string(tmp.path().join("ws.rs")).unwrap();
        // The whole window is rewritten from new_text, normalizing the trailing
        // whitespace away, and the trailing newline is preserved.
        assert_eq!(result, "fn main() {\n    let x = 2;\n}\n");
    }

    #[test]
    fn indentation_fallback_matches_on_leading_whitespace_drift() {
        let tmp = TempDir::new().unwrap();
        // File is indented with a tab; model supplied spaces (or none).
        let content = "if cond {\n\t\tdo_thing();\n}\n";
        fs::write(tmp.path().join("indent.rs"), content).unwrap();

        // Leading whitespace differs, so neither exact nor right-trim matches;
        // tier 3 (full trim) must kick in.
        let output = execute(
            EditFileInput {
                path: "indent.rs".to_string(),
                old_text: "if cond {\n    do_thing();\n}".to_string(),
                new_text: "if cond {\n    done();\n}".to_string(),
                expected_hash: hash_of(content),
                replace_all: None,
            },
            tmp.path(),
        )
        .unwrap();

        assert_eq!(output.strategy, "indentation");
        assert_eq!(output.replacements, 1);
        let result = fs::read_to_string(tmp.path().join("indent.rs")).unwrap();
        assert_eq!(result, "if cond {\n    done();\n}\n");
    }

    #[test]
    fn rejects_ambiguous_whitespace_fallback_without_replace_all() {
        let tmp = TempDir::new().unwrap();
        // File lines carry NO trailing whitespace; old_text lines DO. The exact
        // substring "x = 1; " (trailing space) is absent, so tier 1 fails, but
        // both lines match after right-trimming -> 2 ambiguous windows.
        let content = "x = 1;\nx = 1;\n";
        fs::write(tmp.path().join("amb.rs"), content).unwrap();

        let result = execute(
            EditFileInput {
                path: "amb.rs".to_string(),
                old_text: "x = 1; ".to_string(),
                new_text: "x = 2;".to_string(),
                expected_hash: hash_of(content),
                replace_all: None,
            },
            tmp.path(),
        );

        assert!(matches!(
            result,
            Err(ToolError::InvalidArgs(msg))
                if msg.contains("2 times") && msg.contains("whitespace-insensitive")
        ));
    }

    #[test]
    fn whitespace_fallback_replace_all_hits_every_window() {
        let tmp = TempDir::new().unwrap();
        // Same setup: exact match impossible (old_text has a trailing space the
        // file lines lack), tier 2 matches both windows, replace_all hits both.
        let content = "x = 1;\nx = 1;\n";
        fs::write(tmp.path().join("amb.rs"), content).unwrap();

        let output = execute(
            EditFileInput {
                path: "amb.rs".to_string(),
                old_text: "x = 1; ".to_string(),
                new_text: "x = 2;".to_string(),
                expected_hash: hash_of(content),
                replace_all: Some(true),
            },
            tmp.path(),
        )
        .unwrap();

        assert_eq!(output.strategy, "whitespace");
        assert_eq!(output.replacements, 2);
        let result = fs::read_to_string(tmp.path().join("amb.rs")).unwrap();
        assert_eq!(result, "x = 2;\nx = 2;\n");
    }

    #[test]
    fn not_found_error_mentions_all_three_tiers() {
        let tmp = TempDir::new().unwrap();
        let content = "completely\nunrelated\ncontent\n";
        fs::write(tmp.path().join("nf.txt"), content).unwrap();

        let result = execute(
            EditFileInput {
                path: "nf.txt".to_string(),
                old_text: "no such\nlines here".to_string(),
                new_text: "x".to_string(),
                expected_hash: hash_of(content),
                replace_all: None,
            },
            tmp.path(),
        );

        assert!(matches!(
            result,
            Err(ToolError::InvalidArgs(msg))
                if msg.contains("not found")
                    && msg.contains("indentation-insensitive")
        ));
    }

    #[test]
    fn exact_match_takes_priority_over_fallback() {
        let tmp = TempDir::new().unwrap();
        // An exact occurrence exists alongside whitespace-variant lines; the
        // exact tier should win and replace only the exact one.
        let content = "value = 1;\nvalue = 1;  \n";
        fs::write(tmp.path().join("prio.rs"), content).unwrap();

        let output = execute(
            EditFileInput {
                path: "prio.rs".to_string(),
                old_text: "value = 1;\n".to_string(),
                new_text: "value = 9;\n".to_string(),
                expected_hash: hash_of(content),
                replace_all: None,
            },
            tmp.path(),
        )
        .unwrap();

        // "value = 1;\n" appears exactly once as a substring (the second line
        // has trailing spaces before its newline), so the exact tier matches.
        assert_eq!(output.strategy, "exact");
        assert_eq!(output.replacements, 1);
        let result = fs::read_to_string(tmp.path().join("prio.rs")).unwrap();
        assert_eq!(result, "value = 9;\nvalue = 1;  \n");
    }
}
