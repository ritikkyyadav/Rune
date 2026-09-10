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
//! Every line also carries the kernel's START TIME for the pid. A pid is a
//! number the kernel hands back out, and until V1 proved otherwise the reaper
//! decided to SIGKILL a process GROUP without ever asking whether the number
//! still named the process the line was written for. The start time is
//! assigned at fork and survives `exec` and reparenting, so pid + start time
//! is a name no recycled pid can answer to.
//!
//! `packages/tool-registry/src/tools/process-identity.ts` reads the same two
//! sources and formats the token identically — `/proc/<pid>/stat` field 22 on
//! Linux, `proc_pidinfo(PROC_PIDTBSDINFO)` on macOS — because the reaper on
//! that side has to verify rows written on this one.
//!
//! Best-effort throughout: an unwritable line degrades to the watchdog, which
//! is the primary path. A pid whose identity cannot be read is written without
//! one, and the reaper then forgets that row rather than acting on it. Nothing
//! here may fail a tool call.

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

/// The kernel's identity for a pid, as the ledger records it.
pub(crate) struct ProcessIdentity {
    /// Platform-tagged start time — `linux:<ticks>` or `darwin:<sec>.<usec>`.
    pub start: String,
    /// The process's `comm` right now. Recorded for the report; it is NOT the
    /// tie, because a process keeps its start time across `exec` and loses its
    /// `comm` (`/bin/sh -c "sleep 90"` is `sh`, then `sleep`, same pid).
    pub command: String,
}

/// Reduce a command name to characters that cannot need JSON escaping.
/// Mirrored by `sanitizeCommand` in `process-identity.ts`.
fn sanitize_command(raw: &str) -> String {
    raw.chars()
        .take(64)
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '+' | '@' | ':' | '/' | '-') {
                c
            } else {
                '_'
            }
        })
        .collect()
}

/// Who is at `pid`, or `None` when this machine cannot say.
#[cfg(target_os = "linux")]
pub(crate) fn probe_process(pid: u32) -> Option<ProcessIdentity> {
    let raw = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    // `comm` is parenthesised and may contain spaces and ')', so the LAST ')'
    // is the only reliable split point.
    let open = raw.find('(')?;
    let close = raw.rfind(')')?;
    if close <= open {
        return None;
    }
    let command = sanitize_command(&raw[open + 1..close]);
    let rest: Vec<&str> = raw[close + 1..].split_whitespace().collect();
    // rest[0] is field 3 (state), so field N is rest[N - 3]: starttime is 22.
    let ticks = rest.get(19)?;
    if ticks.is_empty() || !ticks.chars().all(|c| c.is_ascii_digit()) {
        return None;
    }
    Some(ProcessIdentity {
        start: format!("linux:{ticks}"),
        command,
    })
}

/// Who is at `pid`, or `None` when this machine cannot say.
#[cfg(target_os = "macos")]
pub(crate) fn probe_process(pid: u32) -> Option<ProcessIdentity> {
    /// `PROC_PIDTBSDINFO`, from `<sys/proc_info.h>`.
    const PROC_PIDTBSDINFO: libc::c_int = 3;
    let mut info: libc::proc_bsdinfo = unsafe { std::mem::zeroed() };
    let size = std::mem::size_of::<libc::proc_bsdinfo>() as libc::c_int;
    // SAFETY: `info` is a correctly sized, zeroed `proc_bsdinfo`, and the
    // length we pass is its own size. A short return means "no such process".
    let filled = unsafe {
        libc::proc_pidinfo(
            pid as libc::c_int,
            PROC_PIDTBSDINFO,
            0,
            (&raw mut info).cast::<libc::c_void>(),
            size,
        )
    };
    if filled < size {
        return None;
    }
    let comm: String = info
        .pbi_comm
        .iter()
        .take_while(|&&c| c != 0)
        .map(|&c| c as u8 as char)
        .collect();
    Some(ProcessIdentity {
        start: format!("darwin:{}.{}", info.pbi_start_tvsec, info.pbi_start_tvusec),
        command: sanitize_command(&comm),
    })
}

/// Who is at `pid`, or `None` when this machine cannot say.
#[cfg(not(any(target_os = "linux", target_os = "macos")))]
pub(crate) fn probe_process(_pid: u32) -> Option<ProcessIdentity> {
    None
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
    // A row without this cannot be verified, and the reaper forgets rather
    // than kills what it cannot verify — so a machine we cannot read loses
    // reaping, never someone else's process.
    let identity = match probe_process(pid) {
        Some(id) => format!(",\"start\":\"{}\",\"command\":\"{}\"", id.start, id.command),
        None => String::new(),
    };
    let group = match pgid {
        Some(g) => format!("\"pgid\":{g},"),
        None => String::new(),
    };
    let line = format!(
        "{{\"pid\":{pid},{group}\"ownerPid\":{owner},\"at\":\"{at}\",\"tool\":\"{tool}\"{identity}}}\n",
        owner = std::process::id()
    );
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
    fn a_noted_child_carries_the_kernels_identity_for_that_pid() {
        let _guard = ONE_AT_A_TIME.lock().unwrap_or_else(|e| e.into_inner());
        let dir = tempfile::tempdir().unwrap();
        set_workspace(dir.path());
        // Our own pid: a process we know is running, so the probe has an
        // answer and the line has to carry it.
        note(std::process::id(), None, "bash");
        let text = std::fs::read_to_string(ledger_path(dir.path())).unwrap();
        let tag = if cfg!(target_os = "linux") {
            "\"start\":\"linux:"
        } else {
            "\"start\":\"darwin:"
        };
        assert!(text.contains(tag), "{text}");
        assert!(text.contains("\"command\":\""), "{text}");
        // And it is still one JSON object per line that the bridge can parse.
        assert_eq!(text.lines().count(), 1, "{text}");
        assert!(text.trim_end().ends_with('}'), "{text}");
    }

    #[test]
    fn a_pid_the_kernel_does_not_know_is_recorded_without_an_identity() {
        let _guard = ONE_AT_A_TIME.lock().unwrap_or_else(|e| e.into_inner());
        let dir = tempfile::tempdir().unwrap();
        set_workspace(dir.path());
        // No identity is the fail-safe shape: the reaper forgets a row it
        // cannot verify rather than signalling whatever holds the number now.
        note(u32::MAX - 1, Some(u32::MAX - 1), "bash");
        let text = std::fs::read_to_string(ledger_path(dir.path())).unwrap();
        assert!(!text.contains("\"start\":"), "{text}");
        assert!(text.contains("\"pgid\":"), "{text}");
    }

    #[test]
    fn a_command_name_is_reduced_to_characters_that_need_no_escaping() {
        // The name goes into a hand-built JSON line, so a quote or a backslash
        // in it would tear the row the reaper has to parse.
        assert_eq!(sanitize_command("rune-tools"), "rune-tools");
        assert_eq!(sanitize_command("say \"hi\"\\"), "say__hi__");
        assert_eq!(sanitize_command(&"x".repeat(200)).len(), 64);
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
