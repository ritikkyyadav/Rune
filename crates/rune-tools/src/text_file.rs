//! The file contract every rune-tools writer keeps.
//!
//! Measured on 2026-10-14 (docs/evidence/rune-reliability-probes-20261014): edit_file and
//! write_file left every file they wrote at mode 600, rewrote a Latin-1 byte as U+FFFD
//! across the whole file, mixed CRLF and LF in one file, and applied a mis-indented Python
//! edit while reporting success. Claude Code's Edit and Write, given the same inputs,
//! refused or kept the file intact in all six cases. This module is the contract that
//! closes them, in one place for every writer in the crate:
//!
//! - text is strict UTF-8, and a UTF-8 byte-order mark is kept when the file has one; any
//!   other encoding is refused, never converted;
//! - a file's line-ending convention is detected, so an edit can keep it;
//! - a write keeps the permission bits of the file it replaces, and a new file gets what
//!   the process umask gives any new file;
//! - every write is atomic: a temporary file in the same directory, fsync, rename.
//!
//! `packages/tool-registry/src/tools/text-file.ts` is the TypeScript twin for the tools
//! that edit in TypeScript; the two share one conformance table
//! (`tests/helpers/file-contract.ts`).

use std::fs;
use std::io::Write;
use std::path::Path;

use crate::error::ToolError;

const UTF8_BOM: &[u8] = b"\xEF\xBB\xBF";

/// A file's line-ending convention.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Eol {
    Lf,
    Crlf,
}

/// A decoded text file: its text without the byte-order mark, and what it takes to write
/// it back the way it was.
#[derive(Debug)]
pub struct TextFile {
    pub text: String,
    pub bom: bool,
    pub eol: Eol,
}

/// Where a byte sequence stops being UTF-8.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NotUtf8 {
    /// Offset of the first byte that does not decode, counted from the start of the file.
    pub offset: usize,
    /// 1-based line of that byte.
    pub line: usize,
    /// The file opens with a UTF-16 byte-order mark.
    pub utf16: bool,
}

impl NotUtf8 {
    fn cause(&self, path: &str) -> String {
        if self.utf16 {
            format!("{path} is UTF-16 text (it opens with a UTF-16 byte-order mark), not UTF-8")
        } else {
            format!(
                "{path} is not valid UTF-8 (the first undecodable byte is at offset {}, line {}): \
                 it may use a legacy encoding such as Windows-1252, Shift-JIS or GBK, or be binary",
                self.offset, self.line
            )
        }
    }

    /// The refusal a writer returns: the cause, where it is, and the ways forward.
    pub fn refusal(&self, path: &str, tool: &str) -> String {
        format!(
            "{}. {tool} writes UTF-8 and never converts a file's encoding, so nothing was written. \
             Make this change with a shell command that keeps the file's encoding, or ask the user \
             whether to convert the file to UTF-8.",
            self.cause(path)
        )
    }

    /// The note a reader attaches to text it could only show lossily.
    pub fn read_note(&self, path: &str) -> String {
        format!(
            "{}. Bytes that do not decode are shown as U+FFFD. edit_file and write_file will refuse \
             this file: change it with a shell command that keeps its encoding, or ask the user \
             whether to convert it to UTF-8.",
            self.cause(path)
        )
    }
}

fn split_bom(raw: &[u8]) -> (bool, &[u8]) {
    match raw.strip_prefix(UTF8_BOM) {
        Some(rest) => (true, rest),
        None => (false, raw),
    }
}

/// `None` when `raw` is UTF-8, with or without a UTF-8 byte-order mark.
pub fn utf8_problem(raw: &[u8]) -> Option<NotUtf8> {
    let (bom, body) = split_bom(raw);
    let err = std::str::from_utf8(body).err()?;
    let at = err.valid_up_to();
    Some(NotUtf8 {
        offset: at + if bom { UTF8_BOM.len() } else { 0 },
        line: 1 + body[..at].iter().filter(|&&b| b == b'\n').count(),
        utf16: raw.starts_with(&[0xFF, 0xFE]) || raw.starts_with(&[0xFE, 0xFF]),
    })
}

/// Decode a file for editing, or refuse it. `tool` names the caller in the refusal.
pub fn decode(raw: &[u8], path: &str, tool: &str) -> Result<TextFile, ToolError> {
    if let Some(problem) = utf8_problem(raw) {
        return Err(ToolError::InvalidArgs(problem.refusal(path, tool)));
    }
    let (bom, body) = split_bom(raw);
    // Validated above, so this borrows rather than replaces anything.
    let text = String::from_utf8_lossy(body).into_owned();
    Ok(TextFile {
        eol: detect_eol(&text),
        text,
        bom,
    })
}

/// The convention most of the file's line breaks use; LF on a tie or with none at all.
pub fn detect_eol(text: &str) -> Eol {
    let crlf = text.matches("\r\n").count();
    let bare_lf = text.matches('\n').count() - crlf;
    if crlf > bare_lf { Eol::Crlf } else { Eol::Lf }
}

/// `s` with every line break written in `eol`.
pub fn to_eol(s: &str, eol: Eol) -> String {
    let lf = s.replace("\r\n", "\n");
    match eol {
        Eol::Lf => lf,
        Eol::Crlf => lf.replace('\n', "\r\n"),
    }
}

/// The bytes to write for `text`, with the byte-order mark the file had.
pub fn encode(text: &str, bom: bool) -> Vec<u8> {
    let mut out = Vec::with_capacity(text.len() + if bom { UTF8_BOM.len() } else { 0 });
    if bom {
        out.extend_from_slice(UTF8_BOM);
    }
    out.extend_from_slice(text.as_bytes());
    out
}

/// Write `bytes` to `target` atomically: a temporary file in the same directory, fsync,
/// rename.
///
/// `replacing` is the metadata of the file being replaced, if there is one. A rename
/// installs a new inode and the old one's mode goes with it, which is how every write
/// came to land at 0600 (the mode `tempfile` creates with): its permission bits are copied
/// onto the new file before the rename. A new file is created with 0666 under the process
/// umask, like any file a shell or an editor creates.
///
/// Returns a note when the replaced file had other hard links. The rename gives this path
/// new content and leaves the other links with the old content. That is the safe direction
/// (a package manager's shared store must not be edited through one project's link), but
/// the caller should hear about it.
pub fn write_atomic(
    target: &Path,
    bytes: &[u8],
    replacing: Option<&fs::Metadata>,
) -> Result<Option<String>, ToolError> {
    let dir = target
        .parent()
        .filter(|d| !d.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    let io = |detail: String| ToolError::Io {
        path: target.display().to_string(),
        detail,
    };

    let mut builder = tempfile::Builder::new();
    builder.prefix(".rune-tmp-");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if replacing.is_none() {
            builder.permissions(fs::Permissions::from_mode(0o666));
        }
    }
    let mut tmp = builder
        .tempfile_in(dir)
        .map_err(|e| io(format!("Failed to create temp file: {e}")))?;

    tmp.write_all(bytes)
        .map_err(|e| io(format!("Write failed: {e}")))?;
    tmp.as_file()
        .sync_all()
        .map_err(|e| io(format!("Fsync failed: {e}")))?;
    // After the bytes are down, so a read-only original cannot stop its own replacement
    // from being written on platforms where the flag guards the open handle too.
    if let Some(meta) = replacing {
        fs::set_permissions(tmp.path(), meta.permissions())
            .map_err(|e| io(format!("Failed to keep the file's permissions: {e}")))?;
    }
    tmp.persist(target)
        .map_err(|e| io(format!("Rename failed: {}", e.error)))?;

    Ok(hard_link_note(target, replacing))
}

#[cfg(unix)]
fn hard_link_note(target: &Path, replacing: Option<&fs::Metadata>) -> Option<String> {
    use std::os::unix::fs::MetadataExt;
    let links = replacing?.nlink();
    (links > 1).then(|| {
        format!(
            "{} had {links} hard links: this write gave this path new content and left the other \
             {} link(s) with the old content.",
            target.display(),
            links - 1
        )
    })
}

#[cfg(not(unix))]
fn hard_link_note(_target: &Path, _replacing: Option<&fs::Metadata>) -> Option<String> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn utf8_with_and_without_a_bom_decodes() {
        let plain = decode(b"x = 1\n", "a.py", "edit_file").unwrap();
        assert!(!plain.bom);
        assert_eq!(plain.text, "x = 1\n");

        let with_bom = decode(b"\xEF\xBB\xBFx = 1\n", "a.py", "edit_file").unwrap();
        assert!(with_bom.bom);
        assert_eq!(with_bom.text, "x = 1\n");
        assert_eq!(encode(&with_bom.text, with_bom.bom), b"\xEF\xBB\xBFx = 1\n");
    }

    #[test]
    fn a_latin1_byte_is_located_and_refused() {
        let raw = b"line one\n# caf\xe9 latin-1\nx = 1\n";
        let problem = utf8_problem(raw).unwrap();
        assert_eq!(problem.offset, 14);
        assert_eq!(problem.line, 2);
        assert!(!problem.utf16);

        let err = decode(raw, "l.py", "edit_file").unwrap_err().to_string();
        assert!(err.contains("not valid UTF-8"), "{err}");
        assert!(err.contains("offset 14, line 2"), "{err}");
        assert!(err.contains("nothing was written"), "{err}");
    }

    #[test]
    fn the_offset_counts_the_bom() {
        let problem = utf8_problem(b"\xEF\xBB\xBFab\xff").unwrap();
        assert_eq!(problem.offset, 5);
    }

    #[test]
    fn utf16_is_named_as_utf16() {
        let err = decode(b"\xFF\xFEx\x00", "w.txt", "write_file")
            .unwrap_err()
            .to_string();
        assert!(err.contains("UTF-16"), "{err}");
    }

    #[test]
    fn line_endings_follow_the_majority() {
        assert_eq!(detect_eol("a\r\nb\r\nc\n"), Eol::Crlf);
        assert_eq!(detect_eol("a\nb\nc\r\n"), Eol::Lf);
        assert_eq!(detect_eol("a\r\nb\n"), Eol::Lf);
        assert_eq!(detect_eol("no breaks"), Eol::Lf);
        assert_eq!(to_eol("a\nb\r\nc", Eol::Crlf), "a\r\nb\r\nc");
        assert_eq!(to_eol("a\r\nb\nc", Eol::Lf), "a\nb\nc");
    }

    #[cfg(unix)]
    #[test]
    fn a_replaced_file_keeps_its_mode_and_a_new_one_follows_the_umask() {
        use std::os::unix::fs::PermissionsExt;
        let tmp = TempDir::new().unwrap();

        let script = tmp.path().join("run.sh");
        fs::write(&script, "#!/bin/sh\necho hi\n").unwrap();
        fs::set_permissions(&script, fs::Permissions::from_mode(0o755)).unwrap();
        let meta = fs::metadata(&script).unwrap();
        write_atomic(&script, b"#!/bin/sh\necho bye\n", Some(&meta)).unwrap();
        let mode = fs::metadata(&script).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o755);

        // A control file made the ordinary way gets exactly what the umask allows.
        let control = tmp.path().join("control.txt");
        fs::write(&control, "x").unwrap();
        let fresh = tmp.path().join("fresh.txt");
        write_atomic(&fresh, b"x", None).unwrap();
        let want = fs::metadata(&control).unwrap().permissions().mode() & 0o777;
        let got = fs::metadata(&fresh).unwrap().permissions().mode() & 0o777;
        assert_eq!(got, want);
    }

    #[cfg(unix)]
    #[test]
    fn a_hard_linked_file_gets_a_note_and_its_other_link_keeps_the_old_bytes() {
        let tmp = TempDir::new().unwrap();
        let a = tmp.path().join("a.txt");
        let b = tmp.path().join("b.txt");
        fs::write(&a, "old\n").unwrap();
        fs::hard_link(&a, &b).unwrap();

        let meta = fs::metadata(&a).unwrap();
        let note = write_atomic(&a, b"new\n", Some(&meta)).unwrap();
        assert!(note.unwrap().contains("2 hard links"));
        assert_eq!(fs::read_to_string(&a).unwrap(), "new\n");
        assert_eq!(fs::read_to_string(&b).unwrap(), "old\n");
    }
}
