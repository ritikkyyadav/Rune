//! Registry of the one child process a `gear-tools` invocation is running.
//!
//! Why: the CLI interrupts a tool call (Esc) by sending `gear-tools` SIGTERM.
//! Without this registry, gear-tools died but its *grandchild* — the user's
//! actual command, deliberately placed in its own process group so timeouts
//! can kill the whole tree — survived as an orphan holding ports and files,
//! and the "interrupted" bash run kept running for up to its full timeout.
//! The signal handler in gear-tools' main() calls [`kill_active`] so an
//! interrupt tears down the real work, not just the wrapper.
//!
//! One tool per process invocation ⇒ a single atomic slot suffices.

use std::sync::atomic::{AtomicI64, Ordering};

// Encodes (pid << 1) | own_group; 0 = no active child.
static ACTIVE: AtomicI64 = AtomicI64::new(0);

/// Record the child that is now running. `own_group` must be true only when
/// the child was spawned into its own process group (`process_group(0)`);
/// group-killing a child that shares OUR group would kill gear-tools' whole
/// process group — including the CLI that spawned it.
pub fn set(pid: Option<u32>, own_group: bool) {
    let v = match pid {
        Some(p) => ((p as i64) << 1) | (own_group as i64),
        None => 0,
    };
    ACTIVE.store(v, Ordering::SeqCst);
}

/// The child finished (or was already handled) — forget it.
pub fn clear() {
    ACTIVE.store(0, Ordering::SeqCst);
}

/// SIGKILL the registered child — its entire process group when it owns one.
/// Best-effort and idempotent (the slot is consumed).
pub fn kill_active() {
    let v = ACTIVE.swap(0, Ordering::SeqCst);
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
