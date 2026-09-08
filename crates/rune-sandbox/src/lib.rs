//! Platform-specific sandboxing for safe tool execution.
//!
//! This crate provides a `Sandbox` trait with implementations for:
//! - **macOS** — Apple's Seatbelt (`sandbox-exec`) with a dynamically generated profile
//! - **Linux** — Bubblewrap (`bwrap`) with unshared namespaces
//! - **Noop** — Direct execution with `PathGuard` validation (fallback)
//!
//! All implementations apply [`PathGuard`] validation, environment curation,
//! and hash-chained audit logging regardless of whether OS-level sandboxing
//! is active.

pub mod active_child;
pub mod audit;
pub mod error;
pub mod factory;
#[cfg(target_os = "linux")]
pub mod linux;
#[cfg(target_os = "macos")]
pub mod macos;
pub mod noop;
pub mod path_guard;
pub mod shell;
pub mod shell_plan;
pub mod spawn;

use std::collections::HashMap;
use std::future::Future;
use std::path::{Path, PathBuf};
use std::pin::Pin;

use serde::{Deserialize, Serialize};

pub use crate::error::SandboxError;
// `SandboxPathLists` and `real_path` are defined below and re-exported by name.
pub use crate::factory::{SandboxProbe, create_sandbox, probe_capability};
pub use crate::path_guard::PathGuard;
pub use crate::shell::{Shell, command_shell};
pub use crate::shell_plan::{ShellPlan, plan_shell};
pub use crate::spawn::{SpawnPlan, SpawnRequest, ToolCapability, plan_spawn};

/// Escape a path for embedding inside a Seatbelt string literal.
///
/// SBPL string literals are double-quoted; backslashes and double-quotes must
/// be escaped so a workspace path containing them cannot break out of the
/// literal (or silently corrupt the profile).
#[cfg(target_os = "macos")]
pub(crate) fn escape_sbpl(s: &str) -> String {
    s.replace('\\', "\\\\").replace('"', "\\\"")
}

/// Credential and secret stores that stay unreadable under every profile, even
/// where reads are otherwise broad. One list, because two lists become one
/// list plus an omission.
#[cfg(target_os = "macos")]
pub(crate) fn credential_deny_paths() -> Vec<PathBuf> {
    let home = dirs::home_dir().unwrap_or_default();
    vec![
        home.join(".ssh"),
        home.join(".aws"),
        home.join(".gnupg"),
        home.join(".config").join("gh"),
        home.join(".config").join("gcloud"),
        home.join(".kube"),
        home.join(".docker"),
        home.join(".npmrc"),
        home.join(".netrc"),
        home.join(".bash_history"),
        home.join(".zsh_history"),
        home.join(".rune").join("secrets.json"),
        home.join(".gear").join("secrets.json"),
        home.join(".alan").join("secrets.json"),
    ]
}

/// Best-effort real path for a policy entry that may not exist yet.
///
/// The profile matches on RESOLVED paths: on macOS `/tmp` is a symlink to
/// `/private/tmp`, so a rule written against the unresolved path silently
/// matches nothing — a deny that denies nothing is worse than no deny at all.
/// A path that does not exist yet (a hooks directory nobody created) is
/// resolved through its longest existing ancestor and re-joined.
pub fn real_path(path: &Path) -> PathBuf {
    if let Ok(real) = std::fs::canonicalize(path) {
        return real;
    }
    let mut ancestor = path.to_path_buf();
    let mut tail: Vec<std::ffi::OsString> = Vec::new();
    while let Some(parent) = ancestor.parent() {
        if let Some(name) = ancestor.file_name() {
            tail.push(name.to_os_string());
        }
        ancestor = parent.to_path_buf();
        if let Ok(real) = std::fs::canonicalize(&ancestor) {
            let mut out = real;
            for part in tail.iter().rev() {
                out.push(part);
            }
            return out;
        }
    }
    path.to_path_buf()
}

/// The user's path policy for one command, as the TypeScript side resolved it
/// (absolute paths only). Mirrors `SandboxPathLists` in
/// `packages/shared/src/sandbox-policy.ts`.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct SandboxPathLists {
    /// Denied for reading, on top of `credential_deny_paths()`.
    #[serde(default)]
    pub deny_read: Vec<PathBuf>,
    /// Extra writable roots.
    #[serde(default)]
    pub allow_write: Vec<PathBuf>,
    /// Denied for writing even inside a writable root.
    #[serde(default)]
    pub deny_write: Vec<PathBuf>,
}

impl SandboxPathLists {
    /// Fold the lists into a config. Extra write roots are additive; both
    /// deny lists are additive too.
    pub fn apply_to(&self, config: &mut SandboxConfig) {
        config
            .extra_write_paths
            .extend(self.allow_write.iter().cloned());
        config
            .deny_read_paths
            .extend(self.deny_read.iter().cloned());
        config
            .deny_write_paths
            .extend(self.deny_write.iter().cloned());
    }
}

/// Describes the level of sandboxing available on the current platform.
#[derive(Debug, Clone, PartialEq)]
pub enum SandboxCapability {
    /// Full OS-level sandbox (Seatbelt on macOS, bwrap on Linux).
    Full,
    /// PathGuard validation only -- no OS-level isolation.
    PathGuardOnly,
    /// No sandboxing available at all.
    None,
}

/// Configuration for constructing a sandbox.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SandboxConfig {
    /// Root of the workspace the sandbox operates within.
    pub workspace_root: PathBuf,
    /// Default timeout for command execution in milliseconds.
    pub timeout_ms: u64,
    /// Whether outbound network access is permitted.
    pub allow_network: bool,
    /// Additional paths that the sandbox may read (beyond system defaults).
    pub extra_read_paths: Vec<PathBuf>,
    /// Additional paths that the sandbox may write (beyond workspace + cache + tmp).
    pub extra_write_paths: Vec<PathBuf>,
    /// Paths denied for reading, on top of the credential stores in
    /// [`credential_deny_paths`].
    #[serde(default)]
    pub deny_read_paths: Vec<PathBuf>,
    /// Paths denied for writing even where they fall inside a writable root —
    /// Rune's own control files under `<workspace>/.rune`, `.git/hooks`, and
    /// whatever `[sandbox.filesystem] denyWrite` names.
    #[serde(default)]
    pub deny_write_paths: Vec<PathBuf>,
    /// Environment variable overrides merged on top of the curated env.
    pub env_overrides: HashMap<String, String>,
    /// Path to the JSONL audit log file.
    pub audit_log_path: PathBuf,
}

impl Default for SandboxConfig {
    fn default() -> Self {
        let home = dirs::home_dir().unwrap_or_else(|| PathBuf::from("/tmp"));
        Self {
            workspace_root: std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")),
            timeout_ms: 30_000,
            allow_network: false,
            extra_read_paths: Vec::new(),
            extra_write_paths: Vec::new(),
            deny_read_paths: Vec::new(),
            deny_write_paths: Vec::new(),
            env_overrides: HashMap::new(),
            audit_log_path: home.join(".rune").join("audit.jsonl"),
        }
    }
}

/// Result of a sandboxed command execution.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SandboxResult {
    /// Captured standard output.
    pub stdout: String,
    /// Captured standard error.
    pub stderr: String,
    /// Process exit code (`-1` if the process was killed).
    pub exit_code: i32,
    /// Wall-clock duration in milliseconds.
    pub duration_ms: u64,
    /// Whether OS-level sandboxing was active for this execution.
    pub sandboxed: bool,
}

/// Boxed future type alias used by the [`Sandbox`] trait to remain dyn-compatible.
pub type SandboxFuture<'a> =
    Pin<Box<dyn Future<Output = Result<SandboxResult, SandboxError>> + Send + 'a>>;

/// Trait for sandbox implementations.
///
/// All implementations must be `Send + Sync` so they can be stored behind
/// `Box<dyn Sandbox + Send + Sync>` and shared across async tasks.
///
/// The `execute` method returns a [`SandboxFuture`] (pinned, boxed future) so
/// that the trait is dyn-compatible.
pub trait Sandbox: Send + Sync {
    /// Execute a shell command inside the sandbox.
    ///
    /// * `command` — The shell command string (executed via `/bin/sh -c`).
    /// * `cwd` — Working directory; defaults to `SandboxConfig::workspace_root`.
    /// * `timeout_ms` — Per-call timeout override; defaults to the config value.
    fn execute<'a>(
        &'a self,
        command: &'a str,
        cwd: Option<&'a Path>,
        timeout_ms: Option<u64>,
    ) -> SandboxFuture<'a>;

    /// Human-readable name for this sandbox backend.
    fn name(&self) -> &str;
}
