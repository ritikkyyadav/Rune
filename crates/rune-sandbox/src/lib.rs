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
#[cfg(all(test, any(target_os = "linux", target_os = "macos")))]
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

/// The home directory the OS's user database records — `$HOME` does not enter
/// into it.
///
/// V10 critical 5: every rig, test, eval and CI job in this repo establishes
/// isolation by pointing `$HOME`/`RUNE_HOME` at a scratch directory, and that
/// is the entire isolation mechanism. But `~<username>` is a completely
/// ordinary piece of shell syntax that does not consult `$HOME` at all — the
/// shell resolves it through `getpwnam`. So with `$HOME` pointed at a scratch
/// profile, `cat ~ritikyadav890/.rune/memory/.key` reached the real signing
/// key: the deny list that is supposed to make the question moot was built
/// entirely from `dirs::home_dir()`, which honours the override, and therefore
/// did not name the path the shell actually opened.
///
/// `dirs::home_dir()` stays — a scratch profile must protect its own home too.
/// The passwd home is added beside it, so BOTH are denied and neither
/// override can uncover the other.
#[cfg(unix)]
pub fn passwd_home() -> Option<PathBuf> {
    passwd_dir(None)
}

/// The account name the user database records for the effective uid.
///
/// `$USER` is not consulted: it is as overridable as `$HOME`, and the point of
/// this lookup is to be the one answer an environment cannot move.
#[cfg(unix)]
pub fn passwd_user() -> Option<String> {
    use std::ffi::CStr;

    let mut buf = vec![0 as libc::c_char; 4096];
    let mut pwd: libc::passwd = unsafe { std::mem::zeroed() };
    let mut result: *mut libc::passwd = std::ptr::null_mut();
    // SAFETY: every pointer handed to `getpwuid_r` is live for the call.
    let rc = unsafe {
        libc::getpwuid_r(
            libc::geteuid(),
            &mut pwd,
            buf.as_mut_ptr(),
            buf.len(),
            &mut result,
        )
    };
    if rc != 0 || result.is_null() || pwd.pw_name.is_null() {
        return None;
    }
    // SAFETY: `result` is non-null, so `pw_name` points into `buf`.
    let name = unsafe { CStr::from_ptr(pwd.pw_name) };
    name.to_str()
        .ok()
        .map(str::to_string)
        .filter(|n| !n.is_empty())
}

/// The passwd home of `name`, or of the effective uid when `name` is `None`.
#[cfg(unix)]
fn passwd_dir(name: Option<&str>) -> Option<PathBuf> {
    use std::ffi::{CStr, CString, OsStr};
    use std::os::unix::ffi::OsStrExt;

    let mut buf = vec![0 as libc::c_char; 4096];
    let mut pwd: libc::passwd = unsafe { std::mem::zeroed() };
    let mut result: *mut libc::passwd = std::ptr::null_mut();
    let rc = match name {
        Some(name) => {
            let c_name = CString::new(name).ok()?;
            // SAFETY: `pwd`, `buf` and `result` are live for the call; `c_name`
            // is a valid NUL-terminated string. `getpwnam_r` writes only into
            // the buffers it is handed.
            unsafe {
                libc::getpwnam_r(
                    c_name.as_ptr(),
                    &mut pwd,
                    buf.as_mut_ptr(),
                    buf.len(),
                    &mut result,
                )
            }
        }
        // SAFETY: as above, for the effective uid.
        None => unsafe {
            libc::getpwuid_r(
                libc::geteuid(),
                &mut pwd,
                buf.as_mut_ptr(),
                buf.len(),
                &mut result,
            )
        },
    };
    if rc != 0 || result.is_null() || pwd.pw_dir.is_null() {
        return None;
    }
    // SAFETY: `result` is non-null, so `pwd` was filled in and `pw_dir` points
    // into `buf`, which is still alive here.
    let dir = unsafe { CStr::from_ptr(pwd.pw_dir) };
    let path = PathBuf::from(OsStr::from_bytes(dir.to_bytes()));
    if path.as_os_str().is_empty() {
        None
    } else {
        Some(path)
    }
}

/// Every directory that is a home on this machine: the environment's, then the
/// user database's. Deny lists are built from all of them.
#[cfg(any(target_os = "macos", target_os = "linux"))]
pub(crate) fn home_roots() -> Vec<PathBuf> {
    let mut roots: Vec<PathBuf> = Vec::new();
    if let Some(home) = dirs::home_dir()
        && !home.as_os_str().is_empty()
    {
        roots.push(home);
    }
    #[cfg(unix)]
    if let Some(home) = passwd_home()
        && !roots.contains(&home)
    {
        roots.push(home);
    }
    if roots.is_empty() {
        roots.push(PathBuf::new());
    }
    roots
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
pub fn credential_deny_paths() -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = Vec::new();
    for home in home_roots() {
        for leaf in [
            ".ssh",
            ".aws",
            ".gnupg",
            ".config/gh",
            ".config/gcloud",
            ".kube",
            ".docker",
            ".npmrc",
            ".netrc",
            ".bash_history",
            ".zsh_history",
        ] {
            let entry = home.join(leaf);
            if !out.contains(&entry) {
                out.push(entry);
            }
        }
    }
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
    let mut roots = vec![rune_home()];
    for home in home_roots() {
        for name in [".rune", ".gear", ".alan"] {
            let candidate = home.join(name);
            if !roots.contains(&candidate) {
                roots.push(candidate);
            }
        }
    }
    roots
}

/// The credential store a command NAMES, if any — with `~<name>` expanded the
/// way the shell expands it.
///
/// The OS profile is the primary boundary, but it is not always there: when
/// Seatbelt or bubblewrap is unavailable (a nested sandbox, an unprivileged
/// container) the executor falls back to `PathGuard` alone, and a fallback that
/// only knows about destructive verbs lets every credential READ through. This
/// is the same policy as [`credential_deny_paths`], applied one layer earlier
/// so the refusal exists on every executor — and so it is a refusal Rune makes,
/// and therefore one Rune can write to its audit log, rather than an
/// `Operation not permitted` the kernel returns and nobody records.
///
/// Relative paths are not considered: they land in the workspace, which is
/// ordinary project territory.
#[cfg(any(target_os = "macos", target_os = "linux"))]
pub fn credential_path_named(cmd: &str) -> Option<PathBuf> {
    let deny = credential_deny_paths();
    let unquoted = cmd.replace(['\'', '"', '`'], " ");
    for token in unquoted.split(|c: char| {
        c.is_whitespace() || matches!(c, ';' | '|' | '&' | '<' | '>' | '(' | ')' | '=' | ',')
    }) {
        let Some(path) = expand_home_token(token) else {
            continue;
        };
        for entry in &deny {
            if entry.as_os_str().is_empty() {
                continue;
            }
            if path == *entry || path.starts_with(entry) {
                return Some(path);
            }
        }
    }
    None
}

/// Expand the home spellings a shell expands, and keep absolute paths as they
/// are. `None` for anything that is not a path this layer judges.
#[cfg(any(target_os = "macos", target_os = "linux"))]
fn expand_home_token(token: &str) -> Option<PathBuf> {
    let token = token.trim();
    if token.is_empty() {
        return None;
    }
    if let Some(rest) = token.strip_prefix('~') {
        // `~` and `~/…` follow `$HOME`, exactly as the shell does. `~name` and
        // `~name/…` do not — they go to the user database, which is the whole
        // of this finding.
        let (user, rest) = match rest.find('/') {
            Some(i) => (&rest[..i], &rest[i + 1..]),
            None => (rest, ""),
        };
        let root = if user.is_empty() {
            dirs::home_dir().unwrap_or_default()
        } else {
            #[cfg(unix)]
            {
                passwd_dir(Some(user))?
            }
            #[cfg(not(unix))]
            {
                return None;
            }
        };
        return Some(if rest.is_empty() {
            root
        } else {
            root.join(rest)
        });
    }
    for (var, fallback) in [
        ("HOME", None),
        ("RUNE_HOME", Some(())),
        ("GEAR_HOME", Some(())),
        ("ALAN_HOME", Some(())),
    ] {
        for spelling in [format!("${var}"), format!("${{{var}}}")] {
            if let Some(rest) = token.strip_prefix(&spelling) {
                if !rest.is_empty() && !rest.starts_with('/') {
                    continue;
                }
                let root = match std::env::var(var) {
                    Ok(value) if !value.trim().is_empty() => PathBuf::from(value),
                    _ if fallback.is_some() => rune_home(),
                    _ => dirs::home_dir().unwrap_or_default(),
                };
                let rest = rest.trim_start_matches('/');
                return Some(if rest.is_empty() {
                    root
                } else {
                    root.join(rest)
                });
            }
        }
    }
    if token.starts_with('/') {
        return Some(PathBuf::from(token));
    }
    None
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
    let mut out: Vec<String> = Vec::new();
    for home in home_roots() {
        let home = escape_regex(&real_path(&home).display().to_string());
        let rule = format!(r"^{home}/.*\.(key|pem)$");
        if !out.contains(&rule) {
            out.push(rule);
        }
    }
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
