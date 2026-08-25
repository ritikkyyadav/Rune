use std::path::Path;
use std::time::Instant;

use tokio::process::Command;
use tracing::{debug, info, warn};

use crate::audit::{AuditLog, sha256_hash};
use crate::error::SandboxError;
use crate::path_guard::PathGuard;
use crate::{Sandbox, SandboxConfig, SandboxFuture, SandboxResult};

/// Escape a path for embedding inside a Seatbelt string literal.
///
/// SBPL string literals are double-quoted; backslashes and double-quotes must
/// be escaped so a workspace path containing them cannot break out of the
/// literal (or silently corrupt the profile).
fn escape_sb(s: &str) -> String {
    s.replace('\\', "\\\\").replace('"', "\\\"")
}

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
    ///
    /// Threat model: the agent must be able to run real tooling (compilers,
    /// `git`, `node`, ...) but must not (a) write anywhere outside the
    /// workspace, (b) reach the network, or (c) read credential/secret stores.
    ///
    /// Reads are therefore *broad* rather than allowlisted. An allowlist-only
    /// read policy fails closed on modern macOS: `dyld` aborts the process with
    /// `SIGABRT` before `main` if it cannot read the dirs/closures it needs, so
    /// even `echo` never runs. We instead allow reads globally and then carve
    /// out the sensitive paths with explicit denies (a `deny file-read*` on a
    /// subpath wins over the broad allow regardless of rule order in SBPL).
    fn seatbelt_profile(&self) -> String {
        let home = dirs::home_dir().unwrap_or_default();
        let workspace = escape_sb(&self.config.workspace_root.display().to_string());
        let cache_path = escape_sb(&home.join(".gear").join("cache").display().to_string());

        // Writable roots. macOS's per-user temp lives under /private/var/folders
        // (this is what $TMPDIR and confstr(_CS_DARWIN_USER_TEMP_DIR) resolve to);
        // many tools — git/xcrun included — break without it.
        let mut writable: Vec<String> = vec![
            format!("    (subpath \"{workspace}\")"),
            format!("    (subpath \"{cache_path}\")"),
            "    (subpath \"/tmp\")".to_string(),
            "    (subpath \"/private/tmp\")".to_string(),
            "    (subpath \"/private/var/folders\")".to_string(),
        ];
        if let Ok(tmpdir) = std::env::var("TMPDIR") {
            writable.push(format!("    (subpath \"{}\")", escape_sb(&tmpdir)));
        }
        for p in &self.config.extra_write_paths {
            writable.push(format!(
                "    (subpath \"{}\")",
                escape_sb(&p.display().to_string())
            ));
        }
        let writable = writable.join("\n");

        // Credential / secret stores that stay unreadable even under broad reads.
        // Mirrors PathGuard's blocked set, plus tool-specific token locations and
        // Gear's own BYOK secrets file (current and legacy homes).
        let deny_reads: String = [
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
            home.join(".gear").join("secrets.json"),
            home.join(".alan").join("secrets.json"),
        ]
        .iter()
        .map(|p| format!("    (subpath \"{}\")", escape_sb(&p.display().to_string())))
        .collect::<Vec<_>>()
        .join("\n");

        let mut extra_read = String::new();
        for p in &self.config.extra_read_paths {
            extra_read.push_str(&format!(
                "(allow file-read* (subpath \"{}\"))\n",
                escape_sb(&p.display().to_string())
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
(allow process-exec*)
(allow process-fork)
(allow sysctl-read)
(allow mach-lookup)
(allow signal)
(allow process-info*)

;; Broad reads so dyld + real tooling work (see fn docs).
(allow file-read*)

;; ...but never expose credential / secret stores, even to read.
(deny file-read*
{deny_reads}
)

;; Writes confined to the workspace, cache, temp, and pseudo-devices
;; (/dev/null, /dev/urandom, tty, ...). Everything else stays read-only.
(allow file-read* file-write*
{writable}
)
(allow file-write* (subpath "/dev"))

{extra_read}
{network_rule}
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

            let mut cmd = Command::new("sandbox-exec");
            cmd.arg("-p")
                .arg(&profile)
                .arg("/bin/sh")
                .arg("-c")
                .arg(command)
                .current_dir(working_dir)
                .env_clear()
                .envs(&env)
                .envs(&self.config.env_overrides)
                .stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::piped());
            // Own process group so a timeout can kill the whole tree — a
            // dropped wait_with_output future does NOT kill the child, so
            // without this a timed-out command keeps running forever.
            cmd.process_group(0);

            let child = cmd
                .spawn()
                .map_err(|e| SandboxError::SpawnFailed(e.to_string()))?;
            let child_pid = child.id();

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
                if let Some(pid) = child_pid {
                    unsafe {
                        libc::kill(-(pid as i32), libc::SIGKILL);
                    }
                }
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

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::*;
    use crate::SandboxConfig;
    use std::path::PathBuf;

    fn cfg(ws: PathBuf, allow_network: bool) -> SandboxConfig {
        SandboxConfig {
            workspace_root: ws,
            allow_network,
            ..Default::default()
        }
    }

    #[test]
    fn profile_toggles_network_rule() {
        let denied = MacOsSandbox::new(cfg(PathBuf::from("/tmp/ws"), false)).seatbelt_profile();
        assert!(denied.contains("(deny network*)"));
        let allowed = MacOsSandbox::new(cfg(PathBuf::from("/tmp/ws"), true)).seatbelt_profile();
        assert!(allowed.contains("(allow network*)"));
    }

    #[test]
    fn profile_reads_broadly_but_denies_secrets() {
        let p = MacOsSandbox::new(cfg(PathBuf::from("/tmp/ws"), false)).seatbelt_profile();
        // Broad read is the fail-closed fix: dyld must be able to map its libs.
        assert!(p.contains("(allow file-read*)"));
        // ...with credential stores explicitly carved out.
        assert!(p.contains("(deny file-read*"));
        assert!(p.contains(".ssh"));
        assert!(p.contains("secrets.json"));
    }

    #[test]
    fn profile_escapes_quotes_in_workspace_path() {
        let p = MacOsSandbox::new(cfg(PathBuf::from("/tmp/we\"ird"), false)).seatbelt_profile();
        assert!(p.contains("we\\\"ird"));
        assert!(!p.contains("we\"ird")); // the raw, unescaped form must not leak through
    }

    /// Regression for the SIGABRT fail-closed bug: an allowlist-only read policy
    /// aborts `/bin/sh` in dyld before it runs, so a benign command produced no
    /// output. A working sandbox must actually execute it.
    #[tokio::test]
    async fn benign_command_actually_runs() {
        if !MacOsSandbox::is_available() {
            return;
        }
        let ws = tempfile::TempDir::new().unwrap();
        let sb = MacOsSandbox::new(cfg(ws.path().to_path_buf(), false));
        let r = sb
            .execute("echo sandbox-ok", None, Some(15_000))
            .await
            .expect("sandbox execute failed");
        assert_eq!(r.exit_code, 0, "stderr={:?}", r.stderr);
        assert_eq!(r.stdout.trim(), "sandbox-ok");
        assert!(r.sandboxed);
    }

    #[tokio::test]
    async fn writes_inside_workspace_succeed() {
        if !MacOsSandbox::is_available() {
            return;
        }
        let ws = tempfile::TempDir::new().unwrap();
        let sb = MacOsSandbox::new(cfg(ws.path().to_path_buf(), false));
        let r = sb
            .execute("echo hi > marker.txt", None, Some(15_000))
            .await
            .expect("sandbox execute failed");
        assert_eq!(r.exit_code, 0, "stderr={:?}", r.stderr);
        assert!(ws.path().join("marker.txt").exists());
    }

    #[tokio::test]
    async fn writes_outside_workspace_are_blocked() {
        if !MacOsSandbox::is_available() {
            return;
        }
        let home = match dirs::home_dir() {
            Some(h) => h,
            None => return,
        };
        // $HOME root is readable but not writable under the profile.
        let probe = home.join(format!(".gear-sbx-write-probe-{}", std::process::id()));
        let _ = std::fs::remove_file(&probe);

        let ws = tempfile::TempDir::new().unwrap();
        let sb = MacOsSandbox::new(cfg(ws.path().to_path_buf(), false));
        let r = sb
            .execute(
                &format!("echo pwned > {}", probe.display()),
                None,
                Some(15_000),
            )
            .await
            .expect("sandbox execute failed");

        let leaked = probe.exists();
        let _ = std::fs::remove_file(&probe);
        assert!(!leaked, "sandbox allowed a write outside the workspace");
        assert_ne!(r.exit_code, 0, "out-of-workspace write should fail");
    }
}
