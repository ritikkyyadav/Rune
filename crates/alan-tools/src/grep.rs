use regex::Regex;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::Path;
use walkdir::WalkDir;

use crate::error::ToolError;

const DEFAULT_MAX_RESULTS: usize = 100;
const DEFAULT_CONTEXT_LINES: usize = 0;

#[derive(Debug, Deserialize)]
pub struct GrepInput {
    pub pattern: String,
    pub path: Option<String>,
    pub glob: Option<String>,
    pub regex: Option<bool>,
    pub case_insensitive: Option<bool>,
    pub max_results: Option<usize>,
    pub context_lines: Option<usize>,
}

#[derive(Debug, Serialize)]
pub struct GrepMatch {
    pub file: String,
    pub line_number: usize,
    pub content: String,
    pub context_before: Vec<String>,
    pub context_after: Vec<String>,
}

#[derive(Debug, Serialize)]
pub struct GrepOutput {
    pub matches: Vec<GrepMatch>,
    pub total_matches: usize,
    pub truncated: bool,
}

pub fn execute(input: GrepInput, workspace_root: &Path) -> Result<GrepOutput, ToolError> {
    let search_path = if let Some(ref p) = input.path {
        let path = Path::new(p);
        if path.is_absolute() {
            path.to_path_buf()
        } else {
            workspace_root.join(path)
        }
    } else {
        workspace_root.to_path_buf()
    };

    let canonical = fs::canonicalize(&search_path).map_err(|e| ToolError::Io {
        path: search_path.display().to_string(),
        detail: e.to_string(),
    })?;

    let workspace_canonical =
        fs::canonicalize(workspace_root).map_err(|e| ToolError::Io {
            path: workspace_root.display().to_string(),
            detail: e.to_string(),
        })?;

    if !canonical.starts_with(&workspace_canonical) {
        return Err(ToolError::PathEscape {
            path: search_path.display().to_string(),
            workspace: workspace_root.display().to_string(),
        });
    }

    let use_regex = input.regex.unwrap_or(true);
    let case_insensitive = input.case_insensitive.unwrap_or(false);
    let max_results = input.max_results.unwrap_or(DEFAULT_MAX_RESULTS);
    let context_lines = input.context_lines.unwrap_or(DEFAULT_CONTEXT_LINES);

    let pattern = build_pattern(&input.pattern, use_regex, case_insensitive)?;

    let glob_matcher = input
        .glob
        .as_ref()
        .map(|g| {
            globset::Glob::new(g)
                .map_err(|e| ToolError::InvalidArgs(format!("Invalid glob: {e}")))
                .map(|g| g.compile_matcher())
        })
        .transpose()?;

    let mut matches = Vec::new();
    let mut total_matches = 0;

    let files = collect_files(&canonical, &glob_matcher);

    for file_path in files {
        let content = match fs::read_to_string(&file_path) {
            Ok(c) => c,
            Err(_) => continue, // Skip binary/unreadable files
        };

        let lines: Vec<&str> = content.lines().collect();

        for (line_idx, line) in lines.iter().enumerate() {
            if pattern.is_match(line) {
                total_matches += 1;

                if matches.len() < max_results {
                    let rel_path = file_path
                        .strip_prefix(&workspace_canonical)
                        .unwrap_or(&file_path);

                    let ctx_before: Vec<String> = lines
                        [line_idx.saturating_sub(context_lines)..line_idx]
                        .iter()
                        .map(|s| s.to_string())
                        .collect();

                    let ctx_after: Vec<String> = lines
                        [(line_idx + 1)..(line_idx + 1 + context_lines).min(lines.len())]
                        .iter()
                        .map(|s| s.to_string())
                        .collect();

                    matches.push(GrepMatch {
                        file: rel_path.display().to_string(),
                        line_number: line_idx + 1,
                        content: line.to_string(),
                        context_before: ctx_before,
                        context_after: ctx_after,
                    });
                }
            }
        }
    }

    Ok(GrepOutput {
        matches,
        total_matches,
        truncated: total_matches > max_results,
    })
}

fn build_pattern(
    pattern: &str,
    use_regex: bool,
    case_insensitive: bool,
) -> Result<Regex, ToolError> {
    let regex_str = if use_regex {
        if case_insensitive {
            format!("(?i){pattern}")
        } else {
            pattern.to_string()
        }
    } else {
        let escaped = regex::escape(pattern);
        if case_insensitive {
            format!("(?i){escaped}")
        } else {
            escaped
        }
    };

    Regex::new(&regex_str).map_err(|e| ToolError::InvalidArgs(format!("Invalid regex: {e}")))
}

fn collect_files(
    root: &Path,
    glob_matcher: &Option<globset::GlobMatcher>,
) -> Vec<std::path::PathBuf> {
    if root.is_file() {
        return vec![root.to_path_buf()];
    }

    WalkDir::new(root)
        .into_iter()
        .filter_entry(|e| {
            // Always allow the root entry itself
            if e.depth() == 0 {
                return true;
            }
            // Skip hidden directories and common non-text dirs
            let name = e.file_name().to_string_lossy();
            !name.starts_with('.') && name != "node_modules" && name != "target"
        })
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().is_file())
        .filter(|e| {
            if let Some(matcher) = glob_matcher {
                matcher.is_match(e.path().file_name().unwrap_or_default())
            } else {
                true
            }
        })
        .map(|e| e.into_path())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    #[test]
    fn finds_literal_matches() {
        let tmp = TempDir::new().unwrap();
        fs::write(tmp.path().join("code.rs"), "fn main() {\n    println!(\"hello\");\n}\n").unwrap();

        let output = execute(
            GrepInput {
                pattern: "println".to_string(),
                path: None,
                glob: None,
                regex: Some(false),
                case_insensitive: None,
                max_results: None,
                context_lines: None,
            },
            tmp.path(),
        )
        .unwrap();

        assert_eq!(output.total_matches, 1);
        assert_eq!(output.matches[0].line_number, 2);
        assert!(output.matches[0].content.contains("println"));
    }

    #[test]
    fn finds_regex_matches() {
        let tmp = TempDir::new().unwrap();
        fs::write(tmp.path().join("test.ts"), "const foo = 42;\nlet bar = 'hello';\nconst baz = true;\n").unwrap();

        let output = execute(
            GrepInput {
                pattern: r"(const|let)\s+\w+".to_string(),
                path: None,
                glob: None,
                regex: Some(true),
                case_insensitive: None,
                max_results: None,
                context_lines: None,
            },
            tmp.path(),
        )
        .unwrap();

        assert_eq!(output.total_matches, 3);
    }

    #[test]
    fn respects_max_results() {
        let tmp = TempDir::new().unwrap();
        let content: String = (1..=50).map(|i| format!("match line {i}\n")).collect();
        fs::write(tmp.path().join("many.txt"), content).unwrap();

        let output = execute(
            GrepInput {
                pattern: "match".to_string(),
                path: None,
                glob: None,
                regex: Some(false),
                case_insensitive: None,
                max_results: Some(10),
                context_lines: None,
            },
            tmp.path(),
        )
        .unwrap();

        assert_eq!(output.matches.len(), 10);
        assert_eq!(output.total_matches, 50);
        assert!(output.truncated);
    }

    #[test]
    fn includes_context_lines() {
        let tmp = TempDir::new().unwrap();
        fs::write(tmp.path().join("ctx.txt"), "line1\nline2\nTARGET\nline4\nline5\n").unwrap();

        let output = execute(
            GrepInput {
                pattern: "TARGET".to_string(),
                path: None,
                glob: None,
                regex: Some(false),
                case_insensitive: None,
                max_results: None,
                context_lines: Some(2),
            },
            tmp.path(),
        )
        .unwrap();

        assert_eq!(output.matches[0].context_before.len(), 2);
        assert_eq!(output.matches[0].context_after.len(), 2);
        assert_eq!(output.matches[0].context_before[0], "line1");
    }
}
