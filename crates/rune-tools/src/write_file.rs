use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs;
use std::path::Path;

use crate::error::ToolError;
use crate::text_file;

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
    /// What the caller should know about this write (other hard links to the file).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

pub fn execute(input: WriteFileInput, workspace_root: &Path) -> Result<WriteFileOutput, ToolError> {
    let resolved = if Path::new(&input.path).is_absolute() {
        Path::new(&input.path).to_path_buf()
    } else {
        workspace_root.join(&input.path)
    };

    // Both sides through `simplified` — see read_file's note and paths.rs.
    let workspace_canonical = crate::paths::simplified(&fs::canonicalize(workspace_root).map_err(
        |e| ToolError::Io {
            path: workspace_root.display().to_string(),
            detail: e.to_string(),
        },
    )?);

    // Validate workspace containment (parent must exist and be within workspace)
    if let Some(parent) = resolved.parent() {
        // Parent might not exist yet; check the closest existing ancestor
        let mut check_path = parent.to_path_buf();
        while !check_path.exists() {
            match check_path.parent() {
                Some(p) => check_path = p.to_path_buf(),
                None => break,
            }
        }
        if check_path.exists() {
            let canonical_check =
                crate::paths::simplified(&fs::canonicalize(&check_path).map_err(|e| {
                    ToolError::Io {
                        path: check_path.display().to_string(),
                        detail: e.to_string(),
                    }
                })?);
            if !canonical_check.starts_with(&workspace_canonical) {
                return Err(ToolError::PathEscape {
                    path: resolved.display().to_string(),
                    workspace: workspace_root.display().to_string(),
                });
            }
        }
    }

    // A symlink is written through to its target, as edit_file and editors do: the rename
    // used to land a new regular file on the link itself. The target must be inside the
    // workspace too.
    let target = match fs::symlink_metadata(&resolved) {
        Ok(meta) if meta.file_type().is_symlink() => {
            let canonical =
                crate::paths::simplified(&fs::canonicalize(&resolved).map_err(|e| {
                    ToolError::Io {
                        path: resolved.display().to_string(),
                        detail: format!("{e} (a symlink whose target does not exist)"),
                    }
                })?);
            if !canonical.starts_with(&workspace_canonical) {
                return Err(ToolError::PathEscape {
                    path: resolved.display().to_string(),
                    workspace: workspace_root.display().to_string(),
                });
            }
            canonical
        }
        _ => resolved.clone(),
    };

    let created = !target.exists();
    let existing = fs::metadata(&target).ok().filter(|m| m.is_file());

    // An existing file that is not UTF-8 is not overwritten: the write would replace its
    // encoding along with its content, and nothing in the request asked for that.
    if existing.is_some() {
        let raw = fs::read(&target).map_err(|e| ToolError::Io {
            path: target.display().to_string(),
            detail: e.to_string(),
        })?;
        if let Some(problem) = text_file::utf8_problem(&raw) {
            return Err(ToolError::InvalidArgs(format!(
                "{} To replace it with new UTF-8 text anyway, delete it first, then write it.",
                problem.refusal(&input.path, "write_file")
            )));
        }
    }

    // Ensure parent directories exist
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent).map_err(|e| ToolError::Io {
            path: parent.display().to_string(),
            detail: e.to_string(),
        })?;
    }

    // Atomic, and the replaced file's permission bits survive it (probe P2); a new file
    // gets what the umask gives (probe P3).
    let bytes = input.content.as_bytes();
    let note = text_file::write_atomic(&target, bytes, existing.as_ref())?;

    Ok(WriteFileOutput {
        path: resolved.display().to_string(),
        hash: hex::encode(Sha256::digest(bytes)),
        bytes_written: bytes.len(),
        created,
        note,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn write(dir: &Path, path: &str, content: &str) -> Result<WriteFileOutput, ToolError> {
        execute(
            WriteFileInput {
                path: path.to_string(),
                content: content.to_string(),
            },
            dir,
        )
    }

    #[test]
    fn creates_new_file() {
        let tmp = TempDir::new().unwrap();
        let output = write(tmp.path(), "new.txt", "hello world\n").unwrap();

        assert!(output.created);
        assert_eq!(output.bytes_written, 12);
        assert!(!output.hash.is_empty());
        assert!(output.note.is_none());
        assert_eq!(
            fs::read_to_string(tmp.path().join("new.txt")).unwrap(),
            "hello world\n"
        );
    }

    #[test]
    fn overwrites_existing_file() {
        let tmp = TempDir::new().unwrap();
        fs::write(tmp.path().join("existing.txt"), "old content").unwrap();

        let output = write(tmp.path(), "existing.txt", "new content").unwrap();

        assert!(!output.created);
        assert_eq!(
            fs::read_to_string(tmp.path().join("existing.txt")).unwrap(),
            "new content"
        );
    }

    #[test]
    fn creates_parent_directories() {
        let tmp = TempDir::new().unwrap();
        let output = write(tmp.path(), "deep/nested/dir/file.txt", "deep\n").unwrap();

        assert!(output.created);
        assert!(tmp.path().join("deep/nested/dir/file.txt").exists());
    }

    #[test]
    fn rejects_path_outside_workspace() {
        let tmp = TempDir::new().unwrap();
        let outside = TempDir::new().unwrap();

        let result = write(
            tmp.path(),
            &outside.path().join("evil.txt").display().to_string(),
            "evil",
        );

        assert!(matches!(result, Err(ToolError::PathEscape { .. })));
    }

    #[test]
    fn a_file_that_is_not_utf8_is_not_overwritten() {
        let tmp = TempDir::new().unwrap();
        let raw: &[u8] = b"name,city\nJos\xe9,M\xe1laga\n";
        fs::write(tmp.path().join("people.csv"), raw).unwrap();

        let result = write(tmp.path(), "people.csv", "name,city\n");

        match result {
            Err(ToolError::InvalidArgs(msg)) => {
                assert!(msg.contains("not valid UTF-8"), "{msg}");
                assert!(msg.contains("delete it first"), "{msg}");
            }
            other => panic!("expected a refusal, got {other:?}"),
        }
        assert_eq!(fs::read(tmp.path().join("people.csv")).unwrap(), raw);
    }

    /// Probe P2: an overwrite used to leave an executable at mode 600.
    #[cfg(unix)]
    #[test]
    fn an_overwrite_keeps_the_mode() {
        use std::os::unix::fs::PermissionsExt;
        let tmp = TempDir::new().unwrap();
        let script = tmp.path().join("run.sh");
        fs::write(&script, "#!/bin/sh\necho hi\n").unwrap();
        fs::set_permissions(&script, fs::Permissions::from_mode(0o755)).unwrap();

        write(tmp.path(), "run.sh", "#!/bin/sh\necho bye\n").unwrap();

        let mode = fs::metadata(&script).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o755);
    }

    /// Probe P3: a new file used to be created at mode 600 whatever the umask said.
    #[cfg(unix)]
    #[test]
    fn a_new_file_gets_what_the_umask_gives() {
        use std::os::unix::fs::PermissionsExt;
        let tmp = TempDir::new().unwrap();
        fs::write(tmp.path().join("control.txt"), "x").unwrap();

        write(tmp.path(), "fresh.txt", "x").unwrap();

        let want = fs::metadata(tmp.path().join("control.txt"))
            .unwrap()
            .permissions()
            .mode()
            & 0o777;
        let got = fs::metadata(tmp.path().join("fresh.txt"))
            .unwrap()
            .permissions()
            .mode()
            & 0o777;
        assert_eq!(got, want);
    }

    #[cfg(unix)]
    #[test]
    fn a_symlink_is_written_through_to_its_target() {
        let tmp = TempDir::new().unwrap();
        fs::write(tmp.path().join("real.json"), "{}\n").unwrap();
        std::os::unix::fs::symlink("real.json", tmp.path().join("link.json")).unwrap();

        let output = write(tmp.path(), "link.json", "{\"a\": 1}\n").unwrap();

        assert!(!output.created);
        assert_eq!(
            fs::read_to_string(tmp.path().join("real.json")).unwrap(),
            "{\"a\": 1}\n"
        );
        assert!(
            fs::symlink_metadata(tmp.path().join("link.json"))
                .unwrap()
                .file_type()
                .is_symlink()
        );
    }

    #[cfg(unix)]
    #[test]
    fn a_symlink_that_points_out_of_the_workspace_is_refused() {
        let tmp = TempDir::new().unwrap();
        let outside = TempDir::new().unwrap();
        fs::write(outside.path().join("secret.txt"), "keep\n").unwrap();
        std::os::unix::fs::symlink(
            outside.path().join("secret.txt"),
            tmp.path().join("inside.txt"),
        )
        .unwrap();

        let result = write(tmp.path(), "inside.txt", "overwritten\n");

        assert!(matches!(result, Err(ToolError::PathEscape { .. })));
        assert_eq!(
            fs::read_to_string(outside.path().join("secret.txt")).unwrap(),
            "keep\n"
        );
    }
}
