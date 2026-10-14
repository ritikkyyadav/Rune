use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use similar::{ChangeTag, TextDiff};
use std::fs;
use std::path::Path;

use crate::error::ToolError;
use crate::text_file::{self, Eol};

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
    /// How `old_text` was found: "exact", or "line-endings" when it matched only once its
    /// line breaks were written in the file's own convention. Both are byte-exact matches.
    pub strategy: String,
    /// The file had changed since it was last read, and `old_text` still matched it
    /// exactly once, so the edit was applied to the current content.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub changed_since_read: bool,
    /// What the caller should know about this write: the change since the read, other
    /// hard links to the file.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

pub fn execute(input: EditFileInput, workspace_root: &Path) -> Result<EditFileOutput, ToolError> {
    if input.old_text.is_empty() {
        return Err(ToolError::InvalidArgs(
            "old_text is empty: give the exact text to replace (use write_file to create or \
             overwrite a whole file)."
                .to_string(),
        ));
    }

    let resolved = if Path::new(&input.path).is_absolute() {
        Path::new(&input.path).to_path_buf()
    } else {
        workspace_root.join(&input.path)
    };

    // Validate workspace containment. `canonicalize` is VERBATIM on Windows
    // (`\\?\C:\…`); `simplified` puts it back into the spelling every other
    // tool — and the harness's read-before-edit ledger — uses. See src/paths.rs.
    let canonical =
        crate::paths::simplified(&fs::canonicalize(&resolved).map_err(|e| ToolError::Io {
            path: resolved.display().to_string(),
            detail: e.to_string(),
        })?);
    let workspace_canonical = crate::paths::simplified(&fs::canonicalize(workspace_root).map_err(
        |e| ToolError::Io {
            path: workspace_root.display().to_string(),
            detail: e.to_string(),
        },
    )?);

    if !canonical.starts_with(&workspace_canonical) {
        return Err(ToolError::PathEscape {
            path: resolved.display().to_string(),
            workspace: workspace_root.display().to_string(),
        });
    }

    let io = |e: std::io::Error| ToolError::Io {
        path: canonical.display().to_string(),
        detail: e.to_string(),
    };
    let meta = fs::metadata(&canonical).map_err(io)?;
    let raw = fs::read(&canonical).map_err(io)?;
    let current_hash = hex::encode(Sha256::digest(&raw));

    // Strict UTF-8 or nothing: a lossy decode used to write U+FFFD over every byte that
    // did not decode, anywhere in the file, on an edit somewhere else entirely (probe P4).
    let file = text_file::decode(&raw, &input.path, "edit_file")?;

    // A file that changed after it was read is edited only when the text the caller meant
    // is still there exactly once. Anything else means the caller's picture of the file is
    // out of date, and that is what the refusal says (19 of 788 recorded edits were refused
    // for a stale hash that this rule would have let through).
    let stale = current_hash != input.expected_hash;
    let replace_all = input.replace_all.unwrap_or(false);
    let edit = match apply_edit(
        &file.text,
        file.eol,
        &input.old_text,
        &input.new_text,
        replace_all,
        &input.path,
    ) {
        Ok(edit) => edit,
        Err(_) if stale => {
            return Err(ToolError::InvalidArgs(format!(
                "Hash mismatch: {} has changed since it was last read (expected {}, now {}), \
                 and old_text no longer matches it exactly once. Re-read the file first.",
                input.path, input.expected_hash, current_hash
            )));
        }
        Err(err) => return Err(err),
    };

    let new_bytes = text_file::encode(&edit.content, file.bom);
    let diff = generate_diff(&input.path, &file.text, &edit.content);

    let mut notes: Vec<String> = Vec::new();
    if stale {
        notes.push(format!(
            "{} changed after it was last read; old_text still matched exactly once, so the edit \
             was applied to the current content. Re-read it before an edit that depends on the \
             code around this one.",
            input.path
        ));
    }
    // Identical bytes mean there is nothing to write: the file keeps its inode and mtime.
    let link_note = if new_bytes != raw {
        text_file::write_atomic(&canonical, &new_bytes, Some(&meta))?
    } else {
        None
    };
    notes.extend(link_note);

    Ok(EditFileOutput {
        path: canonical.display().to_string(),
        hash: hex::encode(Sha256::digest(&new_bytes)),
        diff,
        replacements: edit.replacements,
        strategy: edit.strategy.to_string(),
        changed_since_read: stale,
        note: (!notes.is_empty()).then(|| notes.join(" ")),
    })
}

/// Result of a successful match and replace.
struct Edit {
    content: String,
    replacements: usize,
    strategy: &'static str,
}

/// Find `old_text` in `content` byte for byte, and replace it.
///
/// Matching is exact, and only exact. Until 2026-10-14 a miss fell back to
/// whitespace-insensitive and then indentation-insensitive line matching, splicing
/// `new_text` in verbatim. When the model's indentation was wrong in `old_text` it was
/// wrong in `new_text` too, so the indentation tier applied a Python edit that no longer
/// parsed and reported success (probe P6). Across 1,448 recorded edit_file and multi_edit
/// edits the two loose tiers had matched 3 times. A miss now says what nearly matched
/// instead (`miss_message`), which is what makes exact matching workable.
///
/// The one conversion allowed is line endings. `old_text` is tried as given, then with its
/// line breaks in the file's convention, then in the other one. Each candidate is still a
/// byte-exact match against the file, and the replacement is written with the line
/// endings of the text it replaces, so a CRLF file stays CRLF (probe P5) and a mixed file
/// keeps its mix outside the edit.
fn apply_edit(
    content: &str,
    eol: Eol,
    old_text: &str,
    new_text: &str,
    replace_all: bool,
    path: &str,
) -> Result<Edit, ToolError> {
    let other = match eol {
        Eol::Lf => Eol::Crlf,
        Eol::Crlf => Eol::Lf,
    };
    let mut candidates: Vec<(String, &'static str)> = vec![(old_text.to_string(), "exact")];
    for convention in [eol, other] {
        let converted = text_file::to_eol(old_text, convention);
        if candidates.iter().all(|(c, _)| *c != converted) {
            candidates.push((converted, "line-endings"));
        }
    }

    for (needle, strategy) in &candidates {
        let count = content.matches(needle.as_str()).count();
        if count == 0 {
            continue;
        }
        if count > 1 && !replace_all {
            return Err(ToolError::InvalidArgs(format!(
                "old_text matches {count} times in {path}. \
                 Use replace_all=true or provide more context to make the match unique."
            )));
        }
        let region = if needle.contains("\r\n") {
            Eol::Crlf
        } else if needle.contains('\n') {
            Eol::Lf
        } else {
            eol
        };
        let replacement = text_file::to_eol(new_text, region);
        let content = if replace_all {
            content.replace(needle.as_str(), &replacement)
        } else {
            content.replacen(needle.as_str(), &replacement, 1)
        };
        return Ok(Edit {
            content,
            replacements: if replace_all { count } else { 1 },
            strategy,
        });
    }

    Err(ToolError::InvalidArgs(miss_message(
        content, old_text, path,
    )))
}

fn strip_cr(line: &str) -> &str {
    line.strip_suffix('\r').unwrap_or(line)
}

/// The first line-window of `lines` that equals `wanted` once both sides go through `norm`.
fn find_window(lines: &[&str], wanted: &[&str], norm: fn(&str) -> &str) -> Option<usize> {
    if wanted.is_empty() || wanted.len() > lines.len() {
        return None;
    }
    (0..=lines.len() - wanted.len()).find(|&i| {
        wanted
            .iter()
            .enumerate()
            .all(|(j, w)| norm(lines[i + j]) == norm(w))
    })
}

fn trim_trailing(s: &str) -> &str {
    s.trim_end_matches([' ', '\t'])
}

fn describe_indent(line: &str) -> String {
    let lead: Vec<char> = line
        .chars()
        .take_while(|c| *c == ' ' || *c == '\t')
        .collect();
    let tabs = lead.iter().filter(|c| **c == '\t').count();
    let spaces = lead.len() - tabs;
    let plural = |n: usize, one: &str| format!("{n} {one}{}", if n == 1 { "" } else { "s" });
    match (tabs, spaces) {
        (0, 0) => "no indentation".to_string(),
        (0, s) => plural(s, "space"),
        (t, 0) => plural(t, "tab"),
        (t, s) => format!("{} and {}", plural(t, "tab"), plural(s, "space")),
    }
}

/// Why `old_text` was not found, in terms the caller can act on: which lines nearly
/// matched and what differs. `packages/tool-registry/src/tools/text-file.ts` words it the
/// same way for multi_edit and apply_patch.
fn miss_message(content: &str, old_text: &str, path: &str) -> String {
    let lines: Vec<&str> = content.split('\n').map(strip_cr).collect();
    let mut wanted: Vec<&str> = old_text.split('\n').map(strip_cr).collect();
    if wanted.len() > 1 && wanted.last() == Some(&"") {
        wanted.pop(); // old_text ended with a line break
    }

    if let Some(start) = find_window(&lines, &wanted, trim_trailing) {
        return format!(
            "old_text not found in {path}. Lines {}–{} match it once trailing whitespace is \
             ignored: copy them exactly as read_file shows them, trailing spaces and tabs included.",
            start + 1,
            start + wanted.len()
        );
    }
    if let Some(start) = find_window(&lines, &wanted, str::trim) {
        let window = &lines[start..start + wanted.len()];
        if let Some((offset, (file_line, wanted_line))) = window
            .iter()
            .zip(wanted.iter())
            .enumerate()
            .find(|(_, (f, w))| describe_indent(f) != describe_indent(w))
        {
            return format!(
                "old_text not found in {path}. Lines {}–{} match it once indentation is ignored: \
                 line {} is indented with {} in the file and {} in old_text. Send old_text and \
                 new_text with the file's own indentation; edits are never re-indented.",
                start + 1,
                start + wanted.len(),
                start + offset + 1,
                describe_indent(file_line),
                describe_indent(wanted_line)
            );
        }
    }
    if let Some(first) = wanted.iter().map(|l| l.trim()).find(|l| !l.is_empty()) {
        let at: Vec<String> = lines
            .iter()
            .enumerate()
            .filter(|(_, l)| l.trim() == first)
            .map(|(i, _)| (i + 1).to_string())
            .take(5)
            .collect();
        if !at.is_empty() {
            return format!(
                "old_text not found in {path}. Its first line appears at line {}, but what \
                 follows differs: re-read that region and copy it exactly.",
                at.join(", ")
            );
        }
    }
    format!(
        "old_text not found in {path}. The file may have changed, or the text differs from what \
         it holds: re-read the region you are editing and copy it exactly."
    )
}

fn generate_diff(path: &str, old: &str, new: &str) -> String {
    let diff = TextDiff::from_lines(old, new);
    let mut output = format!("--- a/{path}\n+++ b/{path}\n");

    for hunk in diff.unified_diff().context_radius(3).iter_hunks() {
        // The header is its own line. `similar` renders it without a trailing
        // newline, so the hunk's first line used to ride on the header itself
        // ("@@ -1,3 +1,5 @@ export function greet…"): every consumer that
        // numbers lines from the header then lost that line and started the
        // gutter one row early (transcript diffs, 2026-09-10).
        output.push_str(&hunk.header().to_string());
        output.push('\n');
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

    fn hash_of(content: &[u8]) -> String {
        hex::encode(Sha256::digest(content))
    }

    fn edit(dir: &Path, path: &str, old: &str, new: &str) -> Result<EditFileOutput, ToolError> {
        let raw = fs::read(dir.join(path)).unwrap();
        execute(
            EditFileInput {
                path: path.to_string(),
                old_text: old.to_string(),
                new_text: new.to_string(),
                expected_hash: hash_of(&raw),
                replace_all: None,
            },
            dir,
        )
    }

    fn refused_with(result: Result<EditFileOutput, ToolError>, needle: &str) -> String {
        match result {
            Err(ToolError::InvalidArgs(msg)) => {
                assert!(msg.contains(needle), "expected {needle:?} in: {msg}");
                msg
            }
            Err(other) => panic!("expected InvalidArgs, got {other}"),
            Ok(out) => panic!("expected a refusal, got an edit: {}", out.diff),
        }
    }

    #[test]
    fn applies_single_edit() {
        let tmp = TempDir::new().unwrap();
        let content = "fn main() {\n    println!(\"hello\");\n}\n";
        fs::write(tmp.path().join("main.rs"), content).unwrap();

        let output = edit(tmp.path(), "main.rs", "\"hello\"", "\"world\"").unwrap();

        assert_eq!(output.replacements, 1);
        assert_eq!(output.strategy, "exact");
        assert!(!output.changed_since_read);
        assert!(output.note.is_none());
        let result = fs::read_to_string(tmp.path().join("main.rs")).unwrap();
        assert!(result.contains("\"world\""));
        assert!(!result.contains("\"hello\""));
        assert!(output.diff.contains("+"));
    }

    #[test]
    fn hunk_header_is_its_own_line() {
        let diff = generate_diff(
            "greet.ts",
            "export function greet(name: string): string {\n  return \"hi \" + name;\n}\n",
            "export function greet(name: string): string {\n  const trimmed = name.trim();\n  return \"hi \" + trimmed;\n}\n",
        );
        let lines: Vec<&str> = diff.lines().collect();
        assert_eq!(lines[2], "@@ -1,3 +1,4 @@");
        assert_eq!(lines[3], " export function greet(name: string): string {");
        assert_eq!(lines[4], "-  return \"hi \" + name;");
        // The declared counts match the body, so a line-numbering consumer
        // starts at the right row.
        let body = &lines[3..];
        assert_eq!(body.iter().filter(|l| !l.starts_with('+')).count(), 3);
        assert_eq!(body.iter().filter(|l| !l.starts_with('-')).count(), 4);
    }

    #[test]
    fn a_stale_hash_is_refused_when_old_text_no_longer_matches() {
        let tmp = TempDir::new().unwrap();
        fs::write(tmp.path().join("file.txt"), "original").unwrap();

        let result = execute(
            EditFileInput {
                path: "file.txt".to_string(),
                old_text: "what the caller remembers".to_string(),
                new_text: "modified".to_string(),
                expected_hash: "wrong_hash".to_string(),
                replace_all: None,
            },
            tmp.path(),
        );

        refused_with(result, "Hash mismatch");
        assert_eq!(
            fs::read_to_string(tmp.path().join("file.txt")).unwrap(),
            "original"
        );
    }

    #[test]
    fn a_stale_hash_is_refused_when_old_text_became_ambiguous() {
        let tmp = TempDir::new().unwrap();
        fs::write(tmp.path().join("file.txt"), "x = 1\nx = 1\n").unwrap();

        let result = execute(
            EditFileInput {
                path: "file.txt".to_string(),
                old_text: "x = 1".to_string(),
                new_text: "x = 2".to_string(),
                expected_hash: hash_of(b"x = 1\n"),
                replace_all: None,
            },
            tmp.path(),
        );

        refused_with(result, "Hash mismatch");
    }

    #[test]
    fn a_stale_hash_still_applies_when_old_text_matches_exactly_once() {
        let tmp = TempDir::new().unwrap();
        // Read as "a\nb\n"; something else appended a line since.
        fs::write(tmp.path().join("file.txt"), "a\nb\nc\n").unwrap();

        let output = execute(
            EditFileInput {
                path: "file.txt".to_string(),
                old_text: "b".to_string(),
                new_text: "B".to_string(),
                expected_hash: hash_of(b"a\nb\n"),
                replace_all: None,
            },
            tmp.path(),
        )
        .unwrap();

        assert!(output.changed_since_read);
        assert!(
            output
                .note
                .as_deref()
                .unwrap()
                .contains("changed after it was last read")
        );
        assert_eq!(
            fs::read_to_string(tmp.path().join("file.txt")).unwrap(),
            "a\nB\nc\n"
        );
        assert_eq!(output.hash, hash_of(b"a\nB\nc\n"));
    }

    #[test]
    fn rejects_non_unique_match_without_replace_all() {
        let tmp = TempDir::new().unwrap();
        fs::write(tmp.path().join("dups.txt"), "foo bar foo baz foo\n").unwrap();

        refused_with(edit(tmp.path(), "dups.txt", "foo", "qux"), "3 times");
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
                expected_hash: hash_of(content.as_bytes()),
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
    fn an_empty_old_text_is_refused() {
        let tmp = TempDir::new().unwrap();
        fs::write(tmp.path().join("f.txt"), "abc\n").unwrap();

        refused_with(edit(tmp.path(), "f.txt", "", "x"), "old_text is empty");
        assert_eq!(
            fs::read_to_string(tmp.path().join("f.txt")).unwrap(),
            "abc\n"
        );
    }

    #[test]
    fn rejects_old_text_not_found() {
        let tmp = TempDir::new().unwrap();
        fs::write(tmp.path().join("file.txt"), "actual content\n").unwrap();

        let msg = refused_with(
            edit(tmp.path(), "file.txt", "does not exist", "replacement"),
            "not found",
        );
        assert!(msg.contains("re-read"), "{msg}");
    }

    #[test]
    fn generates_valid_diff() {
        let tmp = TempDir::new().unwrap();
        fs::write(tmp.path().join("diff.txt"), "line1\nline2\nline3\nline4\n").unwrap();

        let output = edit(tmp.path(), "diff.txt", "line2", "LINE_TWO").unwrap();

        assert!(output.diff.contains("--- a/diff.txt"));
        assert!(output.diff.contains("+++ b/diff.txt"));
        assert!(output.diff.contains("-line2"));
        assert!(output.diff.contains("+LINE_TWO"));
    }

    #[test]
    fn trailing_whitespace_drift_is_refused_and_located() {
        let tmp = TempDir::new().unwrap();
        // The file carries trailing spaces and a tab that old_text leaves out.
        let content = "fn main() {  \n    let x = 1;\t\n}\n";
        fs::write(tmp.path().join("ws.rs"), content).unwrap();

        let msg = refused_with(
            edit(
                tmp.path(),
                "ws.rs",
                "fn main() {\n    let x = 1;\n}",
                "fn main() {\n    let x = 2;\n}",
            ),
            "Lines 1–3 match it once trailing whitespace is ignored",
        );
        assert!(msg.contains("ws.rs"), "{msg}");
        assert_eq!(
            fs::read_to_string(tmp.path().join("ws.rs")).unwrap(),
            content
        );
    }

    #[test]
    fn a_trailing_space_in_old_text_is_not_trimmed_away() {
        let tmp = TempDir::new().unwrap();
        let content = "x = 1;\nx = 1;\n";
        fs::write(tmp.path().join("amb.rs"), content).unwrap();

        refused_with(
            edit(tmp.path(), "amb.rs", "x = 1; ", "x = 2;"),
            "trailing whitespace is ignored",
        );
        assert_eq!(
            fs::read_to_string(tmp.path().join("amb.rs")).unwrap(),
            content
        );
    }

    #[test]
    fn indentation_drift_is_refused_and_named() {
        let tmp = TempDir::new().unwrap();
        // The file indents with tabs; old_text uses spaces.
        let content = "if cond {\n\t\tdo_thing();\n}\n";
        fs::write(tmp.path().join("indent.rs"), content).unwrap();

        let msg = refused_with(
            edit(
                tmp.path(),
                "indent.rs",
                "if cond {\n    do_thing();\n}",
                "if cond {\n    done();\n}",
            ),
            "match it once indentation is ignored",
        );
        assert!(
            msg.contains("line 2 is indented with 2 tabs in the file and 4 spaces in old_text"),
            "{msg}"
        );
        assert_eq!(
            fs::read_to_string(tmp.path().join("indent.rs")).unwrap(),
            content
        );
    }

    /// Probe P6 of docs/evidence/rune-reliability-probes-20261014, which the indentation
    /// tier used to apply with `strategy: "indentation"` and leave unparseable.
    #[test]
    fn the_python_reindent_probe_is_refused() {
        let tmp = TempDir::new().unwrap();
        let content = "def f():\n    if x:\n        return 1\n    return 0\n";
        fs::write(tmp.path().join("p6.py"), content).unwrap();

        refused_with(
            edit(
                tmp.path(),
                "p6.py",
                "if x:\n    return 1",
                "if x:\n    log()\n    return 1",
            ),
            "Lines 2–3 match it once indentation is ignored",
        );
        assert_eq!(
            fs::read_to_string(tmp.path().join("p6.py")).unwrap(),
            content
        );
    }

    #[test]
    fn a_first_line_anchor_is_reported_when_the_rest_differs() {
        let tmp = TempDir::new().unwrap();
        fs::write(tmp.path().join("f.ts"), "const a = 1;\nconst b = 2;\n").unwrap();

        refused_with(
            edit(tmp.path(), "f.ts", "const a = 1;\nconst c = 3;", "x"),
            "first line appears at line 1",
        );
    }

    #[test]
    fn exact_match_is_byte_exact_beside_a_near_twin() {
        let tmp = TempDir::new().unwrap();
        // "value = 1;\n" occurs once; the second line has trailing spaces first.
        let content = "value = 1;\nvalue = 1;  \n";
        fs::write(tmp.path().join("prio.rs"), content).unwrap();

        let output = edit(tmp.path(), "prio.rs", "value = 1;\n", "value = 9;\n").unwrap();

        assert_eq!(output.strategy, "exact");
        assert_eq!(output.replacements, 1);
        let result = fs::read_to_string(tmp.path().join("prio.rs")).unwrap();
        assert_eq!(result, "value = 9;\nvalue = 1;  \n");
    }

    /// Probe P5: LF old_text against a CRLF file.
    #[test]
    fn a_crlf_file_stays_crlf() {
        let tmp = TempDir::new().unwrap();
        fs::write(tmp.path().join("w.txt"), "a = 1\r\nb = 2\r\nc = 3\r\n").unwrap();

        let output = edit(tmp.path(), "w.txt", "a = 1\nb = 2", "a = 10\nb = 20").unwrap();

        assert_eq!(output.strategy, "line-endings");
        assert_eq!(
            fs::read_to_string(tmp.path().join("w.txt")).unwrap(),
            "a = 10\r\nb = 20\r\nc = 3\r\n"
        );
    }

    #[test]
    fn a_one_line_match_in_a_crlf_file_writes_new_lines_as_crlf() {
        let tmp = TempDir::new().unwrap();
        fs::write(tmp.path().join("w.txt"), "a\r\nb\r\n").unwrap();

        let output = edit(tmp.path(), "w.txt", "a", "a\nx").unwrap();

        assert_eq!(output.strategy, "exact");
        assert_eq!(
            fs::read_to_string(tmp.path().join("w.txt")).unwrap(),
            "a\r\nx\r\nb\r\n"
        );
    }

    #[test]
    fn a_mixed_file_keeps_its_mix_outside_the_edit() {
        let tmp = TempDir::new().unwrap();
        // Mostly LF, with one CRLF line break in the middle.
        fs::write(tmp.path().join("m.txt"), "a\nb\r\nc\nd\n").unwrap();

        let output = edit(tmp.path(), "m.txt", "b\nc", "B\nC").unwrap();

        assert_eq!(output.strategy, "line-endings");
        assert_eq!(
            fs::read_to_string(tmp.path().join("m.txt")).unwrap(),
            "a\nB\r\nC\nd\n"
        );
    }

    #[test]
    fn a_utf8_bom_is_kept() {
        let tmp = TempDir::new().unwrap();
        fs::write(tmp.path().join("b.cs"), b"\xEF\xBB\xBFint x = 1;\n").unwrap();

        edit(tmp.path(), "b.cs", "x = 1", "x = 2").unwrap();

        assert_eq!(
            fs::read(tmp.path().join("b.cs")).unwrap(),
            b"\xEF\xBB\xBFint x = 2;\n"
        );
    }

    /// Probe P4: one Latin-1 byte anywhere used to be rewritten as U+FFFD.
    #[test]
    fn a_file_that_is_not_utf8_is_refused_byte_for_byte() {
        let tmp = TempDir::new().unwrap();
        let raw: &[u8] = b"# caf\xe9 latin-1 comment\nx = 1\n";
        fs::write(tmp.path().join("l.py"), raw).unwrap();

        let msg = refused_with(
            edit(tmp.path(), "l.py", "x = 1", "x = 2"),
            "not valid UTF-8",
        );
        assert!(msg.contains("offset 5, line 1"), "{msg}");
        assert!(msg.contains("nothing was written"), "{msg}");
        assert_eq!(fs::read(tmp.path().join("l.py")).unwrap(), raw);
    }

    #[test]
    fn a_no_op_edit_writes_nothing() {
        let tmp = TempDir::new().unwrap();
        fs::write(tmp.path().join("n.txt"), "same\n").unwrap();
        #[cfg(unix)]
        let inode = {
            use std::os::unix::fs::MetadataExt;
            fs::metadata(tmp.path().join("n.txt")).unwrap().ino()
        };

        let output = edit(tmp.path(), "n.txt", "same", "same").unwrap();

        assert_eq!(output.hash, hash_of(b"same\n"));
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            assert_eq!(fs::metadata(tmp.path().join("n.txt")).unwrap().ino(), inode);
        }
    }

    /// Probe P1: an edit used to leave an executable at mode 600.
    #[cfg(unix)]
    #[test]
    fn an_edit_keeps_the_mode() {
        use std::os::unix::fs::PermissionsExt;
        let tmp = TempDir::new().unwrap();
        let script = tmp.path().join("run.sh");
        fs::write(&script, "#!/bin/sh\necho hi\n").unwrap();
        fs::set_permissions(&script, fs::Permissions::from_mode(0o755)).unwrap();

        edit(tmp.path(), "run.sh", "echo hi", "echo bye").unwrap();

        let mode = fs::metadata(&script).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o755);
        assert_eq!(
            fs::read_to_string(&script).unwrap(),
            "#!/bin/sh\necho bye\n"
        );
    }

    #[cfg(unix)]
    #[test]
    fn a_symlink_inside_the_workspace_edits_its_target() {
        let tmp = TempDir::new().unwrap();
        fs::write(tmp.path().join("target.txt"), "old\n").unwrap();
        std::os::unix::fs::symlink("target.txt", tmp.path().join("link.txt")).unwrap();

        edit(tmp.path(), "link.txt", "old", "new").unwrap();

        assert_eq!(
            fs::read_to_string(tmp.path().join("target.txt")).unwrap(),
            "new\n"
        );
        assert!(
            fs::symlink_metadata(tmp.path().join("link.txt"))
                .unwrap()
                .file_type()
                .is_symlink()
        );
    }

    #[cfg(unix)]
    #[test]
    fn a_hard_linked_file_is_edited_at_this_path_and_says_so() {
        let tmp = TempDir::new().unwrap();
        fs::write(tmp.path().join("a.txt"), "old\n").unwrap();
        fs::hard_link(tmp.path().join("a.txt"), tmp.path().join("b.txt")).unwrap();

        let output = edit(tmp.path(), "a.txt", "old", "new").unwrap();

        assert!(output.note.as_deref().unwrap().contains("hard links"));
        assert_eq!(
            fs::read_to_string(tmp.path().join("b.txt")).unwrap(),
            "old\n"
        );
    }
}
