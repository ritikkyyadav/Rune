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

use std::collections::HashMap;
use std::future::Future;
use std::path::{Path, PathBuf};
use std::pin::Pin;

use serde::{Deserialize, Serialize};

pub use crate::error::SandboxError;
pub use crate::factory::{SandboxProbe, create_sandbox, probe_capability};
pub use crate::path_guard::PathGuard;

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
            env_overrides: HashMap::new(),
            audit_log_path: home.join(".gear").join("audit.jsonl"),
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
