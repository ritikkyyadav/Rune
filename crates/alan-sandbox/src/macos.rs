use std::path::Path;
use std::time::Instant;

use tokio::process::Command;
use tracing::{debug, info, warn};

use crate::audit::{AuditLog, sha256_hash};
use crate::error::SandboxError;
use crate::path_guard::PathGuard;
use crate::{Sandbox, SandboxConfig, SandboxFuture, SandboxResult};

/// macOS sandbox-exec (Seatbelt) implementation.
///
/// Generates a Seatbelt profile dynamically based on the workspace root and
/// configuration, then executes the command under `sandbox-exec -p <profile>`.
pub struct MacOsSandbox {
    config: SandboxConfig,
    path_guard: PathGuard,
}

impl MacOsSandbox {
    pub fn new(config: SandboxConfig) -> Self {
        let mut guard = PathGuard::new(config.workspace_root.clone());
        guard.allow_extra_write_paths(config.extra_write_paths.clone());
        Self {
            config,
            path_guard: guard,
        }
    }

    /// Generate a Seatbelt profile string.
    fn seatbelt_profile(&self) -> String {
        let workspace = self.config.workspace_root.display();
        let alan_cache = dirs::home_dir()
            .unwrap_or_default()
            .join(".alan")
            .join("cache");
        let cache_path = alan_cache.display();

        let mut extra_read = String::new();
        for p in &self.config.extra_read_paths {
            extra_read.push_str(&format!(
                "(allow file-read* (subpath \"{}\"))\n",
                p.display()
            ));
        }

        let mut extra_write = String::new();
        for p in &self.config.extra_write_paths {
            extra_write.push_str(&format!(
                "(allow file-read* file-write* (subpath \"{}\"))\n",
                p.display()
            ));
        }

        let network_rule = if self.config.allow_network {
            "(allow network*)"
        } else {
            "(deny network*)"
        };

        format!(
            r#"(version 1)
(deny default)
(allow process-exec)
(allow process-fork)
(allow file-read*
    (subpath "/usr")
    (subpath "/System")
    (subpath "/Library")
    (subpath "/dev")
    (subpath "/private/tmp")
    (subpath "/bin")
    (subpath "/sbin")
    (subpath "/private/var/select")
)
(allow file-read* file-write*
    (subpath "{workspace}")
    (subpath "{cache_path}")
    (subpath "/private/tmp")
)
{extra_read}
{extra_write}
{network_rule}
(allow sysctl-read)
(allow mach-lookup)
(allow signal)
(allow process-info*)
"#
        )
    }

    /// Check whether `sandbox-exec` is available on this system.
    pub fn is_available() -> bool {
        std::process::Command::new("sandbox-exec")
            .arg("-n")
            .arg("no-network")
            .arg("true")
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .is_ok()
    }
}

impl Sandbox for MacOsSandbox {
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
            let profile = self.seatbelt_profile();

            debug!(
                command = command,
                cwd = %working_dir.display(),
                sandbox = "macos-seatbelt",
                "executing sandboxed command"
            );

            let start = Instant::now();

            let child = Command::new("sandbox-exec")
                .arg("-p")
                .arg(&profile)
                .arg("/bin/sh")
                .arg("-c")
                .arg(command)
                .current_dir(working_dir)
                .env_clear()
                .envs(&env)
                .envs(&self.config.env_overrides)
                .stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::piped())
                .spawn()
                .map_err(|e| SandboxError::SpawnFailed(e.to_string()))?;

            let output = tokio::time::timeout(
                std::time::Duration::from_millis(timeout),
                child.wait_with_output(),
            )
            .await
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
                sandbox = "macos-seatbelt",
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
        "macos-seatbelt"
    }
}
