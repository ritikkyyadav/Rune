use std::path::Path;
use std::time::Instant;

use tokio::process::Command;
use tracing::{debug, warn};

use crate::audit::{AuditLog, sha256_hash};
use crate::error::SandboxError;
use crate::path_guard::PathGuard;
use crate::{Sandbox, SandboxConfig, SandboxFuture, SandboxResult};

/// Unsandboxed executor that runs commands directly via `tokio::process::Command`.
///
/// PathGuard validation and environment curation are still applied. This is the
/// fallback on platforms where no sandbox runtime is available.
pub struct NoopSandbox {
    config: SandboxConfig,
    path_guard: PathGuard,
}

impl NoopSandbox {
    pub fn new(config: SandboxConfig) -> Self {
        eprintln!("[WARN] OS-level sandbox unavailable, using PathGuard-only fallback");
        let mut guard = PathGuard::new(config.workspace_root.clone());
        guard.allow_extra_write_paths(config.extra_write_paths.clone());
        Self {
            config,
            path_guard: guard,
        }
    }
}

impl Sandbox for NoopSandbox {
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

            debug!(
                command = command,
                cwd = %working_dir.display(),
                sandbox = "noop",
                "executing command"
            );

            let start = Instant::now();

            // The platform's shell, not `/bin/sh` — which does not exist on
            // Windows, where this spawn failed with os error 3 for every
            // command Rune ran. See shell.rs.
            let sh = crate::shell::command_shell();
            let mut builder = Command::new(&sh.program);
            builder.args(&sh.args);
            let child = builder
                .arg(command)
                .current_dir(working_dir)
                .env_clear()
                .envs(&env)
                .envs(&self.config.env_overrides)
                .stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::piped())
                .spawn()
                .map_err(|e| SandboxError::SpawnFailed(e.to_string()))?;
            // No process_group here, so register pid-only (own_group=false):
            // a group kill would take out rune-tools' own group.
            crate::active_child::set(child.id(), false);

            let waited = tokio::time::timeout(
                std::time::Duration::from_millis(timeout),
                child.wait_with_output(),
            )
            .await;
            crate::active_child::clear();
            let output = waited
                .map_err(|_| {
                    warn!(command = command, timeout_ms = timeout, "command timed out");
                    SandboxError::Timeout(timeout)
                })?
                .map_err(|e| SandboxError::SpawnFailed(e.to_string()))?;

            let duration_ms = start.elapsed().as_millis() as u64;
            let exit_code = output.status.code().unwrap_or(-1);
            let stdout = String::from_utf8_lossy(&output.stdout).to_string();
            let stderr = String::from_utf8_lossy(&output.stderr).to_string();

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
                    false,
                );
            }

            Ok(SandboxResult {
                stdout,
                stderr,
                exit_code,
                duration_ms,
                sandboxed: false,
            })
        })
    }

    fn name(&self) -> &str {
        "noop"
    }
}
