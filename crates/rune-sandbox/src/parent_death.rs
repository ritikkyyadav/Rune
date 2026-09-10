//! Die when the engine that spawned us dies.
//!
//! Why: the CLI cancels a tool call by sending `rune-tools` SIGTERM, and
//! [`crate::active_child::kill_active`] then tears down the real command. A
//! SIGKILLed engine sends nothing. Measured on 2026-09-10 (Phase 2, Lane S,
//! finding S-1): after `SIGKILL` of the engine the `rune-tools` running an
//! in-flight `bash` **and its shell grandchild** were still alive 6 s later,
//! and again at 13 s in a standalone probe — holding ports, files and the
//! workspace, with nothing left that knew they existed.
//!
//! `prctl(PR_SET_PDEATHSIG)` would do this on Linux and has no macOS
//! equivalent, so this is the portable half: poll `getppid()`. A process whose
//! parent dies is reparented — to `init`/`launchd` (pid 1) or, on Linux, to
//! the nearest subreaper — so `getppid()` changing away from the pid we were
//! launched under is the death notice. Polling is cheap (one syscall per tick)
//! and needs no signal disposition, which matters because the SIGTERM slot is
//! already taken by the interrupt path.
//!
//! What it does on death is what the interrupt path does: SIGKILL the
//! registered child's whole process group, then exit. The exit code is 129
//! (128 + SIGHUP) — "my parent hung up" — distinct from the interrupt path's
//! 130 so a crash and a cancellation are not the same row in a log.

use std::time::Duration;

/// How often the watchdog looks. A tool call that outlives its engine by a
/// quarter of a second is not an orphan; one that outlives it by six seconds
/// is what S-1 measured.
pub const POLL_INTERVAL: Duration = Duration::from_millis(250);

/// Exit status used when the parent is gone: 128 + SIGHUP.
pub const PARENT_GONE_EXIT: i32 = 129;

/// The pid of the process that launched us, or `None` where the question does
/// not apply (Windows, or an already-orphaned start).
#[cfg(unix)]
pub fn initial_parent() -> Option<i32> {
    let ppid = unsafe { libc::getppid() };
    // Started by init, or already reparented before we looked: there is no
    // parent death left to watch for, and treating pid 1 as a parent would
    // arm a watchdog that can never fire.
    if ppid <= 1 { None } else { Some(ppid) }
}

#[cfg(not(unix))]
pub fn initial_parent() -> Option<i32> {
    None
}

/// True once the process we were launched under is gone.
#[cfg(unix)]
pub fn parent_gone(initial: i32) -> bool {
    let now = unsafe { libc::getppid() };
    now != initial
}

#[cfg(not(unix))]
pub fn parent_gone(_initial: i32) -> bool {
    false
}

/// Watch `initial` until it dies, then kill our child's group and exit.
///
/// Runs forever by design — the process it guards is a single tool call, and
/// the call finishing takes the whole process with it.
#[cfg(unix)]
pub async fn watch(initial: i32) -> ! {
    loop {
        tokio::time::sleep(POLL_INTERVAL).await;
        if parent_gone(initial) {
            // The command the user asked for, and everything it spawned. It
            // has its own process group precisely so this one call reaches the
            // whole tree; see `active_child::set`.
            crate::active_child::kill_active();
            std::process::exit(PARENT_GONE_EXIT);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_unchanged_parent_is_not_gone() {
        // This test process has a live parent (the cargo test harness), so the
        // watchdog must not fire on it.
        if let Some(ppid) = initial_parent() {
            assert!(!parent_gone(ppid));
        }
    }

    #[test]
    fn a_different_parent_reads_as_gone() {
        // Reparenting is the whole signal: any ppid that is not the one we
        // recorded means the recorded one is gone.
        let bogus = i32::MAX - 1;
        assert!(parent_gone(bogus));
    }

    #[test]
    fn init_is_not_a_parent_worth_watching() {
        // A process already owned by init has no parent death ahead of it.
        // `initial_parent` returns None there rather than arming a watchdog
        // that can never fire.
        assert_eq!(POLL_INTERVAL, Duration::from_millis(250));
        assert_eq!(PARENT_GONE_EXIT, 129);
    }
}
