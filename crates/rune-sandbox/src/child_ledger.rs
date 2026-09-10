//! Write down the command we are running, so something can reap it if we die.
//!
//! [`crate::parent_death`] covers a killed ENGINE: this process notices, kills
//! its command's process group and exits. It cannot cover a killed
//! `rune-tools` — a SIGKILLed process runs no handler — and there the command's
//! group is left with no owner at all and nothing that knows its pid.
//!
//! So the pid and the group id go in a file in the workspace, beside the one
//! the TypeScript bridge writes for THIS process
//! (`packages/tool-registry/src/tools/child-ledger.ts`, same JSONL shape). A
//! restarting engine reads both and, for every entry whose owner is dead and
//! whose child is alive, kills the group and then the pid.
//!
//! Best-effort throughout: an unwritable line degrades to the watchdog, which
//! is the primary path. Nothing here may fail a tool call.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

/// The workspace whose ledger this invocation writes to, set once from `main`.
static LEDGER: Mutex<Option<PathBuf>> = Mutex::new(None);

/// `<workspace>/.rune/tool-children.jsonl` — the file the bridge also appends to.
pub fn ledger_path(workspace: &Path) -> PathBuf {
    workspace.join(".rune").join("tool-children.jsonl")
}

/// Point this invocation's ledger at `workspace`. Called once, from `main`.
pub fn set_workspace(workspace: &Path) {
    if let Ok(mut slot) = LEDGER.lock() {
        *slot = Some(ledger_path(workspace));
    }
}

fn path() -> Option<PathBuf> {
    LEDGER.lock().ok().and_then(|slot| slot.clone())
}

/// Append one record for a child we just spawned.
pub fn note(pid: u32, pgid: Option<u32>, tool: &str) {
    let Some(path) = path() else { return };
    let Some(dir) = path.parent().map(Path::to_path_buf) else {
        return;
    };
    if std::fs::create_dir_all(&dir).is_err() {
        return;
    }
    let at = chrono::Utc::now().to_rfc3339();
    let line = match pgid {
        Some(g) => format!(
            "{{\"pid\":{pid},\"pgid\":{g},\"ownerPid\":{owner},\"at\":\"{at}\",\"tool\":\"{tool}\"}}\n",
            owner = std::process::id()
        ),
        None => format!(
            "{{\"pid\":{pid},\"ownerPid\":{owner},\"at\":\"{at}\",\"tool\":\"{tool}\"}}\n",
            owner = std::process::id()
        ),
    };
    if let Ok(mut file) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
    {
        let _ = file.write_all(line.as_bytes());
    }
}

/// Drop every line this process wrote — the command is over.
///
/// Rewritten whole rather than edited in place: the file is a handful of short
/// lines, and a partial write is what leaves an entry that outlives its child.
pub fn forget(pid: u32) {
    let Some(path) = path() else { return };
    let Ok(text) = std::fs::read_to_string(&path) else {
        return;
    };
    let owner = format!("\"ownerPid\":{}", std::process::id());
    let child = format!("\"pid\":{pid},");
    let kept: Vec<&str> = text
        .lines()
        .filter(|line| !(line.contains(&owner) && line.contains(&child)))
        .filter(|line| !line.trim().is_empty())
        .collect();
    if kept.is_empty() {
        let _ = std::fs::remove_file(&path);
        return;
    }
    let mut body = kept.join("\n");
    body.push('\n');
    let tmp = path.with_extension(format!("jsonl.{}.tmp", std::process::id()));
    if std::fs::write(&tmp, body).is_ok() {
        let _ = std::fs::rename(&tmp, &path);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// These tests share one process-wide `LEDGER`, so they run one at a time.
    static ONE_AT_A_TIME: Mutex<()> = Mutex::new(());

    #[test]
    fn a_noted_child_is_written_and_then_forgotten() {
        let _guard = ONE_AT_A_TIME.lock().unwrap_or_else(|e| e.into_inner());
        let dir = tempfile::tempdir().unwrap();
        set_workspace(dir.path());
        note(4242, Some(4242), "bash");
        let text = std::fs::read_to_string(ledger_path(dir.path())).unwrap();
        assert!(text.contains("\"pid\":4242"), "{text}");
        assert!(text.contains("\"pgid\":4242"), "{text}");
        assert!(
            text.contains(&format!("\"ownerPid\":{}", std::process::id())),
            "{text}"
        );

        forget(4242);
        // The last line went, so the file goes with it rather than being left
        // as an empty ledger a reaper has to parse.
        assert!(!ledger_path(dir.path()).exists());
    }

    #[test]
    fn forget_leaves_another_process_entry_alone() {
        let _guard = ONE_AT_A_TIME.lock().unwrap_or_else(|e| e.into_inner());
        let dir = tempfile::tempdir().unwrap();
        set_workspace(dir.path());
        let path = ledger_path(dir.path());
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        // A line owned by somebody else: a concurrent Rune, or the bridge's
        // record of THIS process. It is not ours to remove.
        std::fs::write(
            &path,
            "{\"pid\":99,\"pgid\":99,\"ownerPid\":123456,\"at\":\"x\",\"tool\":\"bash\"}\n",
        )
        .unwrap();
        note(4243, Some(4243), "bash");
        forget(4243);
        let text = std::fs::read_to_string(&path).unwrap();
        assert!(text.contains("\"pid\":99"), "{text}");
        assert!(!text.contains("\"pid\":4243"), "{text}");
    }

    #[test]
    fn no_workspace_means_no_file_and_no_panic() {
        let _guard = ONE_AT_A_TIME.lock().unwrap_or_else(|e| e.into_inner());
        if let Ok(mut slot) = LEDGER.lock() {
            *slot = None;
        }
        note(1, Some(1), "bash");
        forget(1);
    }
}
