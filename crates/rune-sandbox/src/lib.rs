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
pub mod child_ledger;
pub mod error;
pub mod factory;
#[cfg(target_os = "linux")]
pub mod linux;
#[cfg(target_os = "macos")]
pub mod macos;
pub mod noop;
pub mod parent_death;
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

/// Rune's home directory — the one place the crate writes anything of its own.
///
/// `RUNE_HOME` (and `GEAR_HOME`, the previous name, for compatibility) name the
/// directory itself, not its parent: that is the contract the TypeScript side
/// has honoured since `packages/shared/src/paths.ts`, and every rig, capture
/// script and test harness in this repo sets it expecting a scratch profile.
/// The crate ignored it until now, so every sandboxed `bash` call made by a
/// test run appended to the founder's real `~/.rune/audit.jsonl`. An empty or
/// whitespace-only value is treated as unset rather than as the current
/// directory.
/// A scratch audit log for this crate's own tests (V8 finding 15).
///
/// `SandboxConfig::default()` resolves `audit_log_path` through [`rune_home`],
/// and `cargo test --locked --workspace` runs with no `RUNE_HOME` set — so the
/// five macOS tests that actually execute a command appended seven lines to the
/// founder's real `~/.rune/audit.jsonl` on every run, including the gate run
/// that certified the release. `bunfig.toml`'s preload cannot reach cargo, and
/// the fingerprint everyone checks is the two bun suites, which is exactly why
/// this went unmeasured. Every test config in this crate builds its audit path
/// here instead, under the process's own temp directory.
#[cfg(test)]
pub(crate) fn test_audit_path() -> PathBuf {
    let dir = std::env::temp_dir().join(format!("rune-sandbox-test-{}", std::process::id()));
    let _ = std::fs::create_dir_all(&dir);
    dir.join("audit.jsonl")
}

pub fn rune_home() -> PathBuf {
    for key in ["RUNE_HOME", "GEAR_HOME"] {
        if let Ok(value) = std::env::var(key)
            && !value.trim().is_empty()
        {
            return PathBuf::from(value);
        }
    }
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("/tmp"))
        .join(".rune")
}

/// Credential and secret stores that stay unreadable under every profile, even
/// where reads are otherwise broad. One list, because two lists become one
/// list plus an omission.
///
/// macOS reads broadly and denies these explicitly. Linux binds nothing from
/// $HOME except the named toolchain roots — and checks each one against this
/// list at bind time (`linux::resolve_toolchain_root`), because a root that is
/// a symlink can resolve into a store the fixed list never named — and masks
/// every entry that some other bind did expose (`linux::bwrap_args`).
///
/// V9 criticals 2 and 4: the list named `~/.rune/secrets.json` and stopped.
/// `~/.rune/.env` is the file the installed launcher sources into every
/// invocation — it holds the provider keys, as `scripts/install.sh` says in so
/// many words — and `wc -c < $HOME/.rune/memory/.key` handed a sandboxed `bash`
/// the HMAC secret that the whole memory-integrity design rests on. Both were
/// measured readable through the real binary with the sandbox ON. The memory
/// store, the acceptance vault and the credential index join them for the same
/// reason: a sandboxed command has no business reading any of them, and the
/// deny list is the layer that is supposed to make the question moot.
///
/// Every Rune home is covered, not just `~/.rune`: `rune_home()` first, so a
/// scratch `RUNE_HOME` is protected exactly as the real one is, then the three
/// default homes under `$HOME` so a command that names `~/.rune` directly is
/// refused even when the process runs under a scratch profile.
#[cfg(any(target_os = "macos", target_os = "linux"))]
pub(crate) fn credential_deny_paths() -> Vec<PathBuf> {
    let home = dirs::home_dir().unwrap_or_default();
    let mut out = vec![
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
    ];
    for root in rune_home_roots() {
        for leaf in RUNE_HOME_SECRET_LEAVES {
            let entry = root.join(leaf);
            if !out.contains(&entry) {
                out.push(entry);
            }
        }
    }
    out
}

/// The entries of a Rune home that a sandboxed command may never read.
///
/// `secrets.json` is the BYOK store. `.env` is the launcher's environment file.
/// `memory` holds both the signing key (`memory/.key`) and the entries it signs,
/// which are what every future session is briefed with. `acceptance-pins` is the
/// harness's copy of the oracle a run is graded by. `credentials.index.json` is
/// the account index written by `/login`.
#[cfg(any(target_os = "macos", target_os = "linux"))]
pub(crate) const RUNE_HOME_SECRET_LEAVES: &[&str] = &[
    "secrets.json",
    ".env",
    "credentials.index.json",
    "memory",
    "acceptance-pins",
];

/// Every directory that is a Rune home on this machine: the configured one
/// first, then the three default spellings under `$HOME`.
#[cfg(any(target_os = "macos", target_os = "linux"))]
pub(crate) fn rune_home_roots() -> Vec<PathBuf> {
    let home = dirs::home_dir().unwrap_or_default();
    let mut roots = vec![rune_home()];
    for name in [".rune", ".gear", ".alan"] {
        let candidate = home.join(name);
        if !roots.contains(&candidate) {
            roots.push(candidate);
        }
    }
    roots
}

/// Seatbelt regexes for the credential shapes a fixed path list cannot name.
///
/// A private key is recognized by its extension wherever it sits, so
/// `~/Downloads/deploy.pem` and `~/.rune/org.key` are refused without either
/// being enumerated. The workspace is carved back out by the caller, because a
/// project that keeps a `fixtures/test.pem` under the home is doing ordinary
/// work and a deny that breaks it is a deny that gets switched off.
///
/// macOS only: Seatbelt matches PATTERNS, bubblewrap matches MOUNTS. On Linux
/// the same guarantee is structural — `$HOME` is never bound, and
/// `resolve_toolchain_root` refuses any root that resolves to the home, to an
/// ancestor of it, or to a parent of anything in `credential_deny_paths()`.
#[cfg(target_os = "macos")]
pub(crate) fn credential_deny_regexes() -> Vec<String> {
    // RESOLVED, like every other rule in the profile: Seatbelt matches the real
    // path, so `/tmp/...` written unresolved matches nothing on a machine where
    // `/tmp` is a symlink to `/private/tmp` — which is every macOS machine, and
    // is exactly how the first cut of this rule silently denied nothing.
    let home = escape_regex(
        &real_path(&dirs::home_dir().unwrap_or_default())
            .display()
            .to_string(),
    );
    let mut out = vec![format!(r"^{home}/.*\.(key|pem)$")];
    for root in rune_home_roots() {
        let root = escape_regex(&real_path(&root).display().to_string());
        // `.env`, `.env.local`, `.env.production` — a subpath entry can only
        // name the bare file, and the variants are where a key gets parked.
        out.push(format!(r"^{root}/\.env(\..*)?$"));
    }
    out
}

/// The SBPL block for [`credential_deny_regexes`], with `workspace` carved out.
/// Empty when there is nothing to deny, so the profile never grows a rule with
/// an empty `require-any` (which Seatbelt rejects).
#[cfg(target_os = "macos")]
pub(crate) fn credential_deny_regex_rule(workspace: &str) -> String {
    let regexes = credential_deny_regexes();
    if regexes.is_empty() {
        return String::new();
    }
    // Only the quote is escaped, NOT the backslash: inside an SBPL `#"…"`
    // regex literal a backslash is the regex's own escape, so running the
    // pattern through `escape_sbpl` turns `\.` into `\\.` — "a literal
    // backslash, then any character" — and the rule matches nothing at all.
    // That is a deny that denies nothing, measured through the real binary
    // before it was caught here.
    let body = regexes
        .iter()
        .map(|r| format!("      (regex #\"{}\")", r.replace('"', "\\\"")))
        .collect::<Vec<_>>()
        .join("\n");
    format!(
        ";; ...and the credential SHAPES no fixed path list can name — any\n\
         ;; *.key / *.pem under the home — with the workspace carved back out so\n\
         ;; a project's own test fixture stays readable.\n\
         (deny file-read*\n  (require-all\n    (require-any\n{body}\n    )\n    (require-not (subpath \"{}\"))))\n",
        escape_sbpl(workspace)
    )
}

/// Escape a literal string for use inside a Seatbelt `regex` pattern.
#[cfg(target_os = "macos")]
fn escape_regex(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        if "\\^$.|?*+()[]{}".contains(c) {
            out.push('\\');
        }
        out.push(c);
    }
    out
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
        Self {
            workspace_root: std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")),
            timeout_ms: 30_000,
            allow_network: false,
            extra_read_paths: Vec::new(),
            extra_write_paths: Vec::new(),
            deny_read_paths: Vec::new(),
            deny_write_paths: Vec::new(),
            env_overrides: HashMap::new(),
            audit_log_path: rune_home().join("audit.jsonl"),
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
