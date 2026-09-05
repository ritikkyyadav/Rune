use std::path::Path;
use std::time::Instant;

use tokio::process::Command;
use tracing::{debug, info, warn};

use crate::audit::{AuditLog, sha256_hash};
use crate::error::SandboxError;
use crate::path_guard::PathGuard;
use crate::{Sandbox, SandboxConfig, SandboxFuture, SandboxResult};

/// Linux bubblewrap (bwrap) sandbox implementation.
///
/// Constructs a minimal, unshared namespace with read-only system mounts and
/// read-write access only to the workspace, cache, and temp directories.
pub struct LinuxSandbox {
    config: SandboxConfig,
    path_guard: PathGuard,
}

impl LinuxSandbox {
    pub fn new(config: SandboxConfig) -> Self {
        let mut guard = PathGuard::new(config.workspace_root.clone());
        guard.allow_extra_write_paths(config.extra_write_paths.clone());
        Self {
            config,
            path_guard: guard,
        }
    }

    /// Build the argument list for `bwrap`.
    fn bwrap_args(&self, command: &str, cwd: &Path) -> Vec<String> {
        let workspace = self.config.workspace_root.display().to_string();
        let rune_cache = dirs::home_dir()
            .unwrap_or_default()
            .join(".rune")
            .join("cache");
        let cache_path = rune_cache.display().to_string();

        let mut args: Vec<String> = Vec::new();

        // Read-only system mounts.
        for dir in &["/usr", "/lib", "/lib64", "/bin", "/sbin", "/etc"] {
            if Path::new(dir).exists() {
                args.extend_from_slice(&[
                    "--ro-bind".to_string(),
                    dir.to_string(),
                    dir.to_string(),
                ]);
            }
        }

        // Writable mounts.
        args.extend_from_slice(&["--bind".to_string(), workspace.clone(), workspace.clone()]);

        if rune_cache.exists() {
            args.extend_from_slice(&["--bind".to_string(), cache_path.clone(), cache_path.clone()]);
        }

        args.extend_from_slice(&["--bind".to_string(), "/tmp".to_string(), "/tmp".to_string()]);

        // Extra read-only paths.
        for p in &self.config.extra_read_paths {
            if p.exists() {
                let s = p.display().to_string();
                args.extend_from_slice(&["--ro-bind".to_string(), s.clone(), s]);
            }
        }

        // Extra read-write paths.
        for p in &self.config.extra_write_paths {
            if p.exists() {
                let s = p.display().to_string();
                args.extend_from_slice(&["--bind".to_string(), s.clone(), s]);
            }
        }

        // Pseudo-filesystems.
        args.extend_from_slice(&[
            "--proc".to_string(),
            "/proc".to_string(),
            "--dev".to_string(),
            "/dev".to_string(),
        ]);

        // Namespace isolation.
        if !self.config.allow_network {
            args.push("--unshare-net".to_string());
        }
        args.push("--die-with-parent".to_string());

        // Working directory.
        args.extend_from_slice(&["--chdir".to_string(), cwd.display().to_string()]);

        // The command to run.
        args.extend_from_slice(&["/bin/sh".to_string(), "-c".to_string(), command.to_string()]);

        args
    }

    /// Check whether `bwrap` is available on this system.
    pub fn is_available() -> bool {
        std::process::Command::new("bwrap")
            .arg("--version")
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .is_ok()
    }
}

impl Sandbox for LinuxSandbox {
    fn execute<'a>(
        &'a self,
        command: &'a str,
        cwd: Option<&'a Path>,
        timeout_ms: Option<u64>,
    ) -> SandboxFuture<'a> {
        Box::pin(async move {
            self.path_guard.validate_command(command)?;

            let working_dir = cwd.unwrap_or(&self.config.workspace_root);
            let timeout = timeout_ms.unwrap_or(self.config.timeout_ms);
            let env = self.path_guard.curate_env();
            let args = self.bwrap_args(command, working_dir);

            debug!(
                command = command,
                cwd = %working_dir.display(),
                sandbox = "linux-bwrap",
                "executing sandboxed command"
            );

            let start = Instant::now();

            let child = Command::new("bwrap")
                .args(&args)
                .env_clear()
                .envs(&env)
                .envs(&self.config.env_overrides)
                .stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::piped())
                .spawn()
                .map_err(|e| SandboxError::SpawnFailed(e.to_string()))?;
            // bwrap owns the sandboxed tree; killing the bwrap pid tears it
            // down. No process_group, so pid-only (own_group=false).
            crate::active_child::set(child.id(), false);

            let waited = tokio::time::timeout(
                std::time::Duration::from_millis(timeout),
                child.wait_with_output(),
            )
            .await;
            crate::active_child::clear();
            let output = waited
                .map_err(|_| {
                    warn!(
                        command = command,
                        timeout_ms = timeout,
                        "sandboxed command timed out"
                    );
                    SandboxError::Timeout(timeout)
                })?
                .map_err(|e| SandboxError::SpawnFailed(e.to_string()))?;

            let duration_ms = start.elapsed().as_millis() as u64;
            let exit_code = output.status.code().unwrap_or(-1);
            let stdout = String::from_utf8_lossy(&output.stdout).to_string();
            let stderr = String::from_utf8_lossy(&output.stderr).to_string();

            info!(
                exit_code = exit_code,
                duration_ms = duration_ms,
                sandbox = "linux-bwrap",
                "sandboxed command completed"
            );

            // Audit logging.
            let args_hash = sha256_hash(command);
            let result_hash = sha256_hash(&format!("{stdout}{stderr}"));

            if let Ok(mut audit) = AuditLog::new(self.config.audit_log_path.clone()) {
                let _ = audit.append(
                    "default",
                    "bash",
                    &args_hash,
                    &result_hash,
                    duration_ms,
                    exit_code,
                    true,
                );
            }

            Ok(SandboxResult {
                stdout,
                stderr,
                exit_code,
                duration_ms,
                sandboxed: true,
            })
        })
    }

    fn name(&self) -> &str {
        "linux-bwrap"
    }
}
