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

/// The path to actually bind for a declared toolchain root, or `None` when it
/// must not be bound at all.
///
/// `dir.exists()` follows symlinks, and so does bubblewrap: `--ro-bind` binds
/// what the link POINTS AT. So a root that is itself a link is a hole the
/// fixed list above cannot see, because the list is a promise about resolved
/// paths and was only ever compared against unresolved ones. V1 measured the
/// consequence on the Linux image: with `~/.local/bin -> $HOME`,
/// `cat ~/.local/bin/.ssh/id_rsa` handed a sandboxed command the key while the
/// direct path stayed refused.
///
/// So: resolve first, then judge the resolved path — refusing `$HOME` itself,
/// anything ABOVE `$HOME`, and any parent of a credential store.
pub(crate) fn resolve_toolchain_root(dir: &Path) -> Option<PathBuf> {
    resolve_toolchain_root_in(
        dir,
        &dirs::home_dir().unwrap_or_default(),
        &crate::credential_deny_paths(),
    )
}

/// The judgement itself, with the home directory and the credential list
/// injected so a test can build the hazard rather than needing the machine to have it.
pub(crate) fn resolve_toolchain_root_in(
    dir: &Path,
    home: &Path,
    secrets: &[PathBuf],
) -> Option<PathBuf> {
    // Canonicalize, which also answers "does it exist": a root that is not
    // there is not bound, exactly as before.
    let real = std::fs::canonicalize(dir).ok()?;
    let real_home = std::fs::canonicalize(home).unwrap_or_else(|_| home.to_path_buf());
    // `$HOME` itself, or any ancestor of it — `/`, `/home`, `/root/..`.
    if real_home.starts_with(&real) {
        return None;
    }
    for secret in secrets {
        // Resolved through its longest existing ancestor, so a credential
        // store that does not exist yet is still protected from a root that
        // would come to contain it.
        if crate::real_path(secret).starts_with(&real) {
            return None;
        }
    }
    Some(real)
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
        // Bound from the RESOLVED path to the DECLARED one, so `~/.bun/bin`
        // still exists inside (PATH names it) while what appears there is the
        // directory we actually judged.
        for dir in toolchain_read_roots() {
            let Some(real) = resolve_toolchain_root(&dir) else {
                continue;
            };
            args.extend_from_slice(&[
                "--ro-bind".to_string(),
                real.display().to_string(),
                dir.display().to_string(),
            ]);
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
        // The credential stores, masked the same way — and by the same list the
        // macOS profile denies, so neither platform can be the one that forgot.
        //
        // `$HOME` is not bound, so most of these are already unreachable; this
        // block is what makes that a PROPERTY rather than a coincidence of the
        // bind list. A `[sandbox.filesystem] extraRead` of a home directory, a
        // toolchain root that grew a credential store after it was judged, or a
        // future bind added without this argument in mind, all used to hand the
        // namespace `~/.rune/.env` and `~/.rune/memory/.key` (V9 criticals 2 and
        // 4, measured on macOS through the same list). Masking is cheap and does
        // not depend on remembering.
        for p in self
            .config
            .deny_read_paths
            .iter()
            .chain(crate::credential_deny_paths().iter())
        {
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
            if let Err(err) = self.path_guard.validate_command(command) {
                crate::audit::record_refusal(
                    &self.config.audit_log_path,
                    command,
                    &err.to_string(),
                );
                return Err(err);
            }

            let working_dir = cwd.unwrap_or(&self.config.workspace_root);
            let timeout = timeout_ms.unwrap_or(self.config.timeout_ms);
            let env = self.path_guard.contained_env();
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
            audit_log_path: crate::test_audit_path(),
            ..Default::default()
        };
        LinuxSandbox::new(config).bwrap_args("true", Path::new("/tmp/ws"))
    }

    /// `--ro-bind SRC DST` appears as three consecutive arguments; this asks
    /// only about DST, because a root reached through a symlink is bound from
    /// its RESOLVED source onto the declared path.
    fn has_bind_at(args: &[String], flag: &str, dest: &str) -> bool {
        args.windows(3).any(|w| w[0] == flag && w[2] == dest)
    }

    /// Anything at all bound from, or onto, this path.
    fn touches(args: &[String], path: &str) -> bool {
        args.windows(3)
            .any(|w| (w[0] == "--ro-bind" || w[0] == "--bind") && (w[1] == path || w[2] == path))
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
            if resolve_toolchain_root(&root).is_some() {
                assert!(
                    has_bind_at(&args, "--ro-bind", &s),
                    "toolchain root {s} was not bound read-only"
                );
            } else {
                // Absent, or refused because it resolves somewhere it must not
                // reach. Either way nothing is bound there.
                assert!(
                    !has_bind_at(&args, "--ro-bind", &s),
                    "toolchain root {s} was bound after being refused"
                );
            }
            // Never writable, whether or not it exists.
            assert!(
                !has_bind_at(&args, "--bind", &s),
                "toolchain root {s} must never be writable"
            );
        }

        // The home directory itself is not a mount, in either direction — and
        // not as a bind SOURCE either, which is what a symlinked root would
        // have made it.
        assert!(!touches(&args, &home_s), "$HOME is bound: {home_s}");
    }

    /// V9 criticals 2 and 4, the Linux half. `$HOME` is not bound, so the
    /// credential stores were unreachable by CONSEQUENCE of the bind list. This
    /// asks for the property directly: every store that exists on this machine
    /// is explicitly masked — an empty tmpfs over a directory, `/dev/null` over
    /// a file — so an `extraRead` of a home directory, a toolchain root that
    /// grows a store after it was judged, or a bind added later cannot quietly
    /// hand a sandboxed command `~/.rune/.env` or `~/.rune/memory/.key`.
    #[test]
    fn every_credential_store_that_exists_is_masked() {
        let args = args_for(false);
        let mut checked = 0;
        for secret in credential_deny_paths() {
            let s = secret.display().to_string();
            if secret.is_dir() {
                assert!(
                    args.windows(2).any(|w| w[0] == "--tmpfs" && w[1] == s),
                    "the credential directory {s} is not masked"
                );
                checked += 1;
            } else if secret.exists() {
                assert!(
                    args.windows(3)
                        .any(|w| w[0] == "--ro-bind" && w[1] == "/dev/null" && w[2] == s),
                    "the credential file {s} is not masked"
                );
                checked += 1;
            }
        }
        // A loop over an empty list proves nothing; the image this runs in has
        // `~/.ssh`, and the mask must come after every bind it could carve out
        // of, or a later bind over the same path re-exposes it.
        assert!(
            checked > 0,
            "no credential store exists to mask — the assertion above ran zero times"
        );
        let first_mask = args
            .iter()
            .enumerate()
            .find(|(i, a)| {
                *a == "--tmpfs"
                    || (*a == "--ro-bind" && args.get(i + 1).is_some_and(|n| n == "/dev/null"))
            })
            .map(|(i, _)| i)
            .expect("at least one mask, since `checked` is non-zero");
        let workspace_bind = args
            .iter()
            .position(|a| a == "--bind")
            .expect("the workspace is bound");
        assert!(
            first_mask > workspace_bind,
            "a mask precedes the binds it must override — bubblewrap takes the LAST mount over a path"
        );
    }

    #[test]
    fn no_bound_toolchain_root_is_a_parent_of_a_credential_store() {
        // Compared on RESOLVED paths, and on what is actually BOUND rather
        // than on what is declared: `secret.starts_with(&root)` over the two
        // unresolved paths cannot see a root that is a symlink, which is
        // exactly the hole V1 walked through. `~/.cargo/bin` is still exposed,
        // because `~/.cargo/credentials.toml` is not inside it.
        let home = crate::real_path(&dirs::home_dir().unwrap_or_default());
        for root in toolchain_read_roots() {
            let Some(real) = resolve_toolchain_root(&root) else {
                continue; // refused, so it exposes nothing
            };
            assert_ne!(real, home, "the home directory is not a toolchain root");
            for secret in credential_deny_paths() {
                assert!(
                    !crate::real_path(&secret).starts_with(&real),
                    "toolchain root {} resolves to {} and exposes the credential store {}",
                    root.display(),
                    real.display(),
                    secret.display()
                );
            }
        }
    }

    #[test]
    fn a_toolchain_root_that_is_a_symlink_to_the_home_is_refused() {
        // The hazard V1 built on the Linux image: `~/.local/bin -> $HOME`.
        // `exists()` says yes, the lexical guard says the root is `.local/bin`
        // and the secret is `.ssh`, and bubblewrap binds the whole home.
        let home = tempfile::tempdir().unwrap();
        let home = home.path();
        std::fs::create_dir_all(home.join(".local")).unwrap();
        std::os::unix::fs::symlink(home, home.join(".local/bin")).unwrap();
        std::fs::create_dir_all(home.join(".ssh")).unwrap();
        let secrets = vec![home.join(".ssh"), home.join(".aws")];

        assert_eq!(
            resolve_toolchain_root_in(&home.join(".local/bin"), home, &secrets),
            None,
            "a root that resolves to $HOME must not be bound"
        );
    }

    #[test]
    fn a_toolchain_root_resolves_through_a_harmless_symlink() {
        // The same mechanism must not break the ordinary case: a version
        // manager that points ~/.local/bin at a real directory elsewhere.
        let home = tempfile::tempdir().unwrap();
        let home = home.path();
        let elsewhere = tempfile::tempdir().unwrap();
        let real = std::fs::canonicalize(elsewhere.path()).unwrap();
        std::fs::create_dir_all(home.join(".local")).unwrap();
        std::os::unix::fs::symlink(&real, home.join(".local/bin")).unwrap();
        let secrets = vec![home.join(".ssh")];

        assert_eq!(
            resolve_toolchain_root_in(&home.join(".local/bin"), home, &secrets),
            Some(real),
        );
        // And a root that is not there at all is still simply not bound.
        assert_eq!(
            resolve_toolchain_root_in(&home.join(".nope"), home, &secrets),
            None
        );
    }

    #[test]
    fn a_toolchain_root_that_resolves_above_a_credential_store_is_refused() {
        // Not $HOME, but a parent of one of the stores — `~/.local/bin -> ~/.ssh/..`
        // is the same escape with one more step.
        let home = tempfile::tempdir().unwrap();
        let home = home.path();
        let stash = home.join("stash");
        std::fs::create_dir_all(stash.join("gnupg")).unwrap();
        std::fs::create_dir_all(home.join(".local")).unwrap();
        std::os::unix::fs::symlink(&stash, home.join(".local/bin")).unwrap();

        assert_eq!(
            resolve_toolchain_root_in(
                &home.join(".local/bin"),
                home,
                &[stash.join("gnupg"), home.join(".ssh")],
            ),
            None
        );
    }
}
