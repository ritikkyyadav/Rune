//! Registry of the one child process a `rune-tools` invocation is running.
//!
//! Why: the CLI interrupts a tool call (Esc) by sending `rune-tools` SIGTERM.
//! Without this registry, rune-tools died but its *grandchild* — the user's
//! actual command, deliberately placed in its own process group so timeouts
//! can kill the whole tree — survived as an orphan holding ports and files,
//! and the "interrupted" bash run kept running for up to its full timeout.
//! The signal handler in rune-tools' main() calls [`kill_active`] so an
//! interrupt tears down the real work, not just the wrapper.
//!
//! One tool per process invocation ⇒ a single atomic slot suffices.
//!
//! **Out of scope: a child that leaves the group.** A command that calls
//! `setsid(2)` — `setsid`, `start_new_session=True`, a daemon that
//! double-forks — is in a session of its own, and neither [`kill_active`] nor
//! [`crate::parent_death`] nor the restart reaper can reach it. Measured on
//! macOS and on the no-backend path: such a child survives the group kill. On
//! Linux the bubblewrap backend puts the command in its own PID namespace, so
//! a daemonised grandchild dies with the namespace. Documented in
//! `docs/sandbox.md`; a tool that daemonises itself on macOS is stopped the
//! way any daemon is.

use std::sync::atomic::{AtomicI64, Ordering};

// Encodes (pid << 1) | own_group; 0 = no active child.
static ACTIVE: AtomicI64 = AtomicI64::new(0);

/// Record the child that is now running. `own_group` must be true only when
/// the child was spawned into its own process group (`process_group(0)`);
/// group-killing a child that shares OUR group would kill rune-tools' whole
/// process group — including the CLI that spawned it.
pub fn set(pid: Option<u32>, own_group: bool) {
    let v = match pid {
        Some(p) => ((p as i64) << 1) | (own_group as i64),
        None => 0,
    };
    ACTIVE.store(v, Ordering::SeqCst);
    // And write it down, so a SIGKILL of THIS process — which runs no handler
    // and cannot reach the atomic above — still leaves something a restarting
    // engine can reap. See child_ledger.rs.
    if let Some(p) = pid {
        crate::child_ledger::note(p, if own_group { Some(p) } else { None }, "command");
    }
}

/// The child finished (or was already handled) — forget it.
pub fn clear() {
    let v = ACTIVE.swap(0, Ordering::SeqCst);
    if v != 0 {
        crate::child_ledger::forget((v >> 1) as u32);
    }
}

/// SIGKILL the registered child — its entire process group when it owns one.
/// Best-effort and idempotent (the slot is consumed).
pub fn kill_active() {
    let v = ACTIVE.swap(0, Ordering::SeqCst);
    if v != 0 {
        crate::child_ledger::forget((v >> 1) as u32);
    }
    #[cfg(unix)]
    if v != 0 {
        let pid = (v >> 1) as i32;
        let grouped = (v & 1) == 1;
        unsafe {
            if grouped {
                libc::kill(-pid, libc::SIGKILL);
            }
            libc::kill(pid, libc::SIGKILL);
        }
    }
    #[cfg(not(unix))]
    let _ = v;
}
