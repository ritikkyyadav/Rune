use std::path::{Path, PathBuf};
use std::time::Instant;

use tokio::process::Command;
use tracing::{debug, info, warn};

use crate::audit::{AuditLog, sha256_hash};
use crate::error::SandboxError;
use crate::path_guard::PathGuard;
use crate::{Sandbox, SandboxConfig, SandboxFuture, SandboxResult};

/// Read-only toolchain roots under $HOME: language runtimes, version managers
/// and the directories people install single binaries into.
///
/// The rule for adding an entry: it must hold PROGRAMS. `~/.cargo/bin` is
/// here and `~/.cargo` is not, because the latter also holds
/// `credentials.toml`. Nothing here may be $HOME, a parent of $HOME, or a
/// parent of anything in [`crate::credential_deny_paths`].
pub(crate) fn toolchain_read_roots() -> Vec<PathBuf> {
    let Some(home) = dirs::home_dir() else {
        return Vec::new();
    };
    [
        // Rust
        ".cargo/bin",
        ".rustup",
        // JavaScript / TypeScript
        ".bun/bin",
        ".nvm",
        ".volta",
        ".deno/bin",
        ".npm-global/bin",
        ".yarn/bin",
        ".local/share/pnpm",
        // Python, Ruby, Java, Go
        ".pyenv",
        ".rbenv",
        ".sdkman",
        ".jenv",
        "go/bin",
        // Generic user-installed binaries and polyglot version managers
        ".local/bin",
        ".local/share/mise",
    ]
    .iter()
    .map(|rel| home.join(rel))
    .collect()
}

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
        guard.deny_extra_write_paths(config.deny_write_paths.clone());
        Self {
            config,
            path_guard: guard,
        }
    }

    /// Build the argument list for `bwrap`.
    pub(crate) fn bwrap_args(&self, command: &str, cwd: &Path) -> Vec<String> {
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

        // Home-installed toolchains, read-only.
        //
        // A namespace shows only what is bound. `cargo`, `bun`, `node`,
        // `python` and friends installed under $HOME are therefore invisible
        // inside the sandbox even though PATH still names them: the command
        // fails with "not found", and the obvious fix — bind the whole home —
        // would hand a sandboxed command the user's ~/.ssh, ~/.aws, shell
        // history and Rune's own configuration. So: a fixed list of toolchain
        // directories, each read-only and each only when it exists. Every
        // entry is a program/toolchain root; no credential store, no dotfile,
        // no $HOME itself, and no parent of any of those.
        for dir in toolchain_read_roots() {
            if dir.exists() {
                let s = dir.display().to_string();
                args.extend_from_slice(&["--ro-bind".to_string(), s.clone(), s]);
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

        // Policy denials, AFTER the binds they carve out of: a later bind over
        // the same path masks the earlier one. A denied write becomes a
        // read-only view of itself; a denied read becomes an empty tmpfs (a
        // directory) or a bind of /dev/null (a file). Paths that do not exist
        // need no mask — there is nothing to reach.
        for p in &self.config.deny_write_paths {
            if p.exists() {
                let s = p.display().to_string();
                args.extend_from_slice(&["--ro-bind".to_string(), s.clone(), s]);
            }
        }
        for p in &self.config.deny_read_paths {
            if p.is_dir() {
                args.extend_from_slice(&["--tmpfs".to_string(), p.display().to_string()]);
            } else if p.exists() {
                args.extend_from_slice(&[
                    "--ro-bind".to_string(),
                    "/dev/null".to_string(),
                    p.display().to_string(),
                ]);
            }
        }

        // Pseudo-filesystems.
        args.extend_from_slice(&[
            "--proc".to_string(),
            "/proc".to_string(),
            "--dev".to_string(),
            "/dev".to_string(),
        ]);

        // Bubblewrap creates otherwise-writable parent directories for the
        // bind destinations. Seal that synthetic root after mounting: only
        // explicitly writable mounts (workspace/cache/tmp) remain writable.
        args.extend_from_slice(&["--remount-ro".to_string(), "/".to_string()]);

        // Keep process, IPC and hostname namespaces separate even when a
        // command needs the host network. The PID namespace also prevents an
        // orphaned descendant surviving teardown of the sandbox's init.
        args.push("--unshare-all".to_string());
        if self.config.allow_network {
            args.push("--share-net".to_string());
        }
        args.push("--new-session".to_string());
        args.extend_from_slice(&["--cap-drop".to_string(), "ALL".to_string()]);
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

            let mut builder = Command::new("bwrap");
            builder
                .args(&args)
                .env_clear()
                .envs(&env)
                .envs(&self.config.env_overrides)
                .stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::piped());
            // bwrap owns the sandboxed tree and killing the bwrap pid tears it
            // down — but only if something is alive to send that kill. Its own
            // process group makes the whole subtree reachable from one
            // `kill(-pgid)`, which is what the parent-death watchdog and the
            // interrupt handler both use (Phase 2, S-1).
            builder.process_group(0);
            let child = builder
                .spawn()
                .map_err(|e| SandboxError::SpawnFailed(e.to_string()))?;
            crate::active_child::set(child.id(), true);

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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::credential_deny_paths;

    fn args_for(allow_network: bool) -> Vec<String> {
        let config = SandboxConfig {
            workspace_root: PathBuf::from("/tmp/ws"),
            allow_network,
            ..Default::default()
        };
        LinuxSandbox::new(config).bwrap_args("true", Path::new("/tmp/ws"))
    }

    /// `--ro-bind SRC DST` appears as three consecutive arguments.
    fn has_pair(args: &[String], flag: &str, path: &str) -> bool {
        args.windows(3)
            .any(|w| w[0] == flag && w[1] == path && w[2] == path)
    }

    #[test]
    fn the_namespace_root_is_sealed_and_the_process_is_stripped() {
        let args = args_for(false);
        // The synthetic parents bubblewrap creates for the bind destinations
        // are writable until this remount; `../outside.txt` landed there.
        let remount = args
            .iter()
            .position(|a| a == "--remount-ro")
            .expect("the namespace root is remounted read-only");
        assert_eq!(args[remount + 1], "/");
        assert!(args.iter().any(|a| a == "--unshare-all"));
        assert!(args.iter().any(|a| a == "--new-session"));
        assert!(args.iter().any(|a| a == "--die-with-parent"));
        let cap = args.iter().position(|a| a == "--cap-drop").unwrap();
        assert_eq!(args[cap + 1], "ALL");
        assert!(!args.iter().any(|a| a == "--share-net"));
    }

    #[test]
    fn network_is_restored_only_when_permitted() {
        assert!(args_for(true).iter().any(|a| a == "--share-net"));
        assert!(args_for(true).iter().any(|a| a == "--unshare-all"));
    }

    #[test]
    fn home_toolchains_are_visible_read_only_without_exposing_the_home() {
        let args = args_for(false);
        let home = dirs::home_dir().unwrap_or_default();
        let home_s = home.display().to_string();

        for root in toolchain_read_roots() {
            let s = root.display().to_string();
            if root.exists() {
                assert!(
                    has_pair(&args, "--ro-bind", &s),
                    "toolchain root {s} was not bound read-only"
                );
            }
            // Never writable, whether or not it exists.
            assert!(
                !has_pair(&args, "--bind", &s),
                "toolchain root {s} must never be writable"
            );
        }

        // The home directory itself is not a mount, in either direction.
        assert!(!has_pair(&args, "--ro-bind", &home_s));
        assert!(!has_pair(&args, "--bind", &home_s));
    }

    #[test]
    fn no_toolchain_root_is_a_parent_of_a_credential_store() {
        // The list is a fixed constant, so this is a property of the code,
        // not of the machine it runs on: `~/.cargo/bin` may be exposed
        // because `~/.cargo/credentials.toml` is not inside it.
        let home = dirs::home_dir().unwrap_or_default();
        for root in toolchain_read_roots() {
            assert_ne!(root, home, "the home directory is not a toolchain root");
            for secret in credential_deny_paths() {
                assert!(
                    !secret.starts_with(&root),
                    "toolchain root {} exposes the credential store {}",
                    root.display(),
                    secret.display()
                );
            }
        }
    }
}
