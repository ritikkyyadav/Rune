use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs;
use std::path::{Path, PathBuf};

use crate::error::ToolError;

const MAX_FILE_SIZE: u64 = 10 * 1024 * 1024; // 10 MB
const DEFAULT_LINE_LIMIT: usize = 2000;

/// Largest image we will hand back as base64. Anthropic's wire limit is 5 MB
/// AFTER base64 (which inflates 4/3), so 3.5 MB raw keeps every provider happy.
const MAX_IMAGE_BYTES: usize = 3_584_000;

/// How much of a file to sniff when deciding whether it is text.
const SNIFF_BYTES: usize = 8192;

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
    /// "text" | "image" | "binary". Text files behave exactly as before.
    pub kind: &'static str,
    /// Set for images, so the harness can build a real image content block.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub media_type: Option<String>,
    /// Base64 pixels for an image small enough to send. The harness lifts this
    /// OUT of the text result — it must never reach a transcript as characters.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub base64: Option<String>,
    pub bytes: u64,
}

/// Image formats every vision-capable provider accepts, keyed by magic bytes
/// rather than extension — a screenshot saved as `.txt` is still a screenshot,
/// and a `.png` full of JSON is still text.
fn sniff_image(raw: &[u8]) -> Option<&'static str> {
    if raw.starts_with(&[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A]) {
        return Some("image/png");
    }
    if raw.starts_with(&[0xFF, 0xD8, 0xFF]) {
        return Some("image/jpeg");
    }
    if raw.starts_with(b"GIF87a") || raw.starts_with(b"GIF89a") {
        return Some("image/gif");
    }
    if raw.len() >= 12 && raw.starts_with(b"RIFF") && &raw[8..12] == b"WEBP" {
        return Some("image/webp");
    }
    None
}

/// A NUL byte in the first few KB is the classic, cheap binary test: no text
/// encoding Gear reads emits one, and every executable, archive, and database
/// does within its header.
fn looks_binary(raw: &[u8]) -> bool {
    raw.iter().take(SNIFF_BYTES).any(|&b| b == 0)
}

const B64: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/// Standard base64 with padding (RFC 4648 §4). Written out rather than pulled
/// in: twenty lines of table lookup is a smaller thing to own than another
/// dependency in the binary that reads the user's files.
fn base64_encode(raw: &[u8]) -> String {
    let mut out = String::with_capacity(raw.len().div_ceil(3) * 4);
    for chunk in raw.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = *chunk.get(1).unwrap_or(&0) as u32;
        let b2 = *chunk.get(2).unwrap_or(&0) as u32;
        let n = (b0 << 16) | (b1 << 8) | b2;
        out.push(B64[(n >> 18 & 63) as usize] as char);
        out.push(B64[(n >> 12 & 63) as usize] as char);
        out.push(if chunk.len() > 1 {
            B64[(n >> 6 & 63) as usize] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            B64[(n & 63) as usize] as char
        } else {
            '='
        });
    }
    out
}

fn human_bytes(n: u64) -> String {
    if n >= 1_048_576 {
        format!("{:.1} MB", n as f64 / 1_048_576.0)
    } else if n >= 1024 {
        format!("{:.1} KB", n as f64 / 1024.0)
    } else {
        format!("{n} B")
    }
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
    let size = metadata.len();

    // ── Images: hand back pixels, never characters ──
    // `from_utf8_lossy` on a screenshot used to emit a few hundred KB of
    // replacement-character mojibake as "file content". It taught the model
    // nothing, and it cost more context than the rest of the turn combined.
    if let Some(media_type) = sniff_image(&raw) {
        let too_big = raw.len() > MAX_IMAGE_BYTES;
        let content = if too_big {
            format!(
                "[image] {} · {} · {} — too large to attach (limit {}). \
                 Resize or crop it, then read it again.",
                input.path,
                media_type,
                human_bytes(size),
                human_bytes(MAX_IMAGE_BYTES as u64)
            )
        } else {
            format!(
                "[image] {} · {} · {} — the pixels are attached below; describe only what you see in them.",
                input.path,
                media_type,
                human_bytes(size)
            )
        };
        return Ok(ReadFileOutput {
            path: resolved.display().to_string(),
            content,
            hash,
            total_lines: 0,
            lines_shown: 0,
            offset: 0,
            truncated: false,
            kind: "image",
            media_type: Some(media_type.to_string()),
            base64: if too_big {
                None
            } else {
                Some(base64_encode(&raw))
            },
            bytes: size,
        });
    }

    // ── Other binaries: describe, do not transcribe ──
    if looks_binary(&raw) {
        return Ok(ReadFileOutput {
            path: resolved.display().to_string(),
            content: format!(
                "[binary] {} · {} · sha256 {} — not text, so there is nothing to read here. \
                 Use a tool that understands this format if you need its contents.",
                input.path,
                human_bytes(size),
                &hash[..16]
            ),
            hash,
            total_lines: 0,
            lines_shown: 0,
            offset: 0,
            truncated: false,
            kind: "binary",
            media_type: None,
            base64: None,
            bytes: size,
        });
    }

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
        kind: "text",
        media_type: None,
        base64: None,
        bytes: size,
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
    // BOTH sides through `simplified`, always. `starts_with` compares
    // components, so a verbatim `\\?\C:\ws` and a plain `C:\ws\f.txt` share
    // no prefix at all and containment would fail on Windows for every file in
    // the workspace. See src/paths.rs.
    let canonical =
        crate::paths::simplified(&fs::canonicalize(path).map_err(|e| ToolError::Io {
            path: path.display().to_string(),
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

    // ── Images and binaries ──
    // Before this, `from_utf8_lossy` turned a 130 KB screenshot into ~327 KB of
    // replacement-character mojibake and called it file content. It taught the
    // model nothing and cost more context than the rest of the turn.

    /// A 1x1 PNG, byte for byte.
    fn tiny_png() -> Vec<u8> {
        vec![
            0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D, 0x49, 0x48,
            0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00,
            0x00, 0x1F, 0x15, 0xC4, 0x89, 0x00, 0x00, 0x00, 0x0A, 0x49, 0x44, 0x41, 0x54, 0x78,
            0x9C, 0x63, 0x00, 0x01, 0x00, 0x00, 0x05, 0x00, 0x01, 0x0D, 0x0A, 0x2D, 0xB4, 0x00,
            0x00, 0x00, 0x00, 0x49, 0x45, 0x4E, 0x44, 0xAE, 0x42, 0x60, 0x82,
        ]
    }

    fn read(tmp: &TempDir, name: &str) -> ReadFileOutput {
        execute(
            ReadFileInput {
                path: name.to_string(),
                offset: None,
                limit: None,
            },
            tmp.path(),
        )
        .unwrap()
    }

    #[test]
    fn base64_matches_the_rfc_vectors() {
        assert_eq!(base64_encode(b""), "");
        assert_eq!(base64_encode(b"f"), "Zg==");
        assert_eq!(base64_encode(b"fo"), "Zm8=");
        assert_eq!(base64_encode(b"foo"), "Zm9v");
        assert_eq!(base64_encode(b"foob"), "Zm9vYg==");
        assert_eq!(base64_encode(b"fooba"), "Zm9vYmE=");
        assert_eq!(base64_encode(b"foobar"), "Zm9vYmFy");
    }

    #[test]
    fn an_image_comes_back_as_pixels_not_characters() {
        let tmp = TempDir::new().unwrap();
        let png = tiny_png();
        fs::write(tmp.path().join("shot.png"), &png).unwrap();

        let out = read(&tmp, "shot.png");

        assert_eq!(out.kind, "image");
        assert_eq!(out.media_type.as_deref(), Some("image/png"));
        assert_eq!(out.base64.as_deref().unwrap(), base64_encode(&png));
        // The text half stays short and says what it is.
        assert!(out.content.starts_with("[image]"));
        assert!(out.content.len() < 200);
        // No mojibake anywhere in what a transcript would show.
        assert!(!out.content.contains('\u{FFFD}'));
    }

    #[test]
    fn image_detection_reads_magic_bytes_not_the_extension() {
        let tmp = TempDir::new().unwrap();
        // A screenshot saved as .txt is still a screenshot ...
        fs::write(tmp.path().join("shot.txt"), tiny_png()).unwrap();
        assert_eq!(read(&tmp, "shot.txt").kind, "image");
        // ... and a .png full of JSON is still text.
        fs::write(tmp.path().join("data.png"), "{\"a\":1}\n").unwrap();
        let text = read(&tmp, "data.png");
        assert_eq!(text.kind, "text");
        assert!(text.base64.is_none());
    }

    #[test]
    fn an_oversized_image_is_described_and_not_attached() {
        let tmp = TempDir::new().unwrap();
        let mut big = tiny_png();
        big.resize(MAX_IMAGE_BYTES + 1, 0x41);
        fs::write(tmp.path().join("huge.png"), &big).unwrap();

        let out = read(&tmp, "huge.png");
        assert_eq!(out.kind, "image");
        assert!(out.base64.is_none());
        assert!(out.content.contains("too large to attach"));
    }

    #[test]
    fn a_non_image_binary_is_described_not_transcribed() {
        let tmp = TempDir::new().unwrap();
        fs::write(
            tmp.path().join("a.bin"),
            [0x7F, 0x45, 0x4C, 0x46, 0x00, 0x01, 0x02],
        )
        .unwrap();

        let out = read(&tmp, "a.bin");
        assert_eq!(out.kind, "binary");
        assert!(out.base64.is_none());
        assert!(out.content.starts_with("[binary]"));
        assert!(out.content.len() < 250);
    }

    #[test]
    fn text_files_are_completely_unchanged() {
        let tmp = TempDir::new().unwrap();
        fs::write(tmp.path().join("t.txt"), "line1\nline2\n").unwrap();

        let out = read(&tmp, "t.txt");
        assert_eq!(out.kind, "text");
        assert_eq!(out.total_lines, 2);
        assert!(out.content.contains("line1"));
        assert!(out.base64.is_none());
        assert!(out.media_type.is_none());
    }
}
