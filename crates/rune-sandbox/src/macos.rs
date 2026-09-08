use std::path::Path;
use std::time::Instant;

use tokio::process::Command;
use tracing::{debug, info, warn};

use crate::audit::{AuditLog, sha256_hash};
use crate::error::SandboxError;
use crate::path_guard::PathGuard;
use crate::{Sandbox, SandboxConfig, SandboxFuture, SandboxResult};

use crate::{credential_deny_paths, escape_sbpl as escape_sb, real_path};

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
        guard.deny_extra_write_paths(config.deny_write_paths.clone());
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
    pub(crate) fn seatbelt_profile(&self) -> String {
        let home = dirs::home_dir().unwrap_or_default();
        let workspace = escape_sb(&self.config.workspace_root.display().to_string());
        let cache_path = escape_sb(&home.join(".rune").join("cache").display().to_string());

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
                escape_sb(&real_path(p).display().to_string())
            ));
        }
        let writable = writable.join("\n");

        // Writes denied INSIDE the writable roots: Rune's own control surface
        // in the workspace (config, hooks, skills, policy), `.git/hooks`, and
        // the user's `[sandbox.filesystem] denyWrite`. Emitted only when the
        // list is non-empty — a bare `(deny file-write*)` would deny every
        // write, which is the opposite of a narrow carve-out. Seatbelt takes
        // the last matching rule, so this block follows the allow.
        let deny_writes: Vec<String> = self
            .config
            .deny_write_paths
            .iter()
            .map(|p| {
                format!(
                    "    (subpath \"{}\")",
                    escape_sb(&real_path(p).display().to_string())
                )
            })
            .collect();
        let deny_write_rule = if deny_writes.is_empty() {
            String::new()
        } else {
            format!(
                ";; ...except Rune's own controls and policy-denied paths, even inside a writable root.\n(deny file-write*\n{}\n)\n",
                deny_writes.join("\n")
            )
        };

        // Credential / secret stores that stay unreadable even under broad reads.
        // Mirrors PathGuard's blocked set, plus tool-specific token locations and
        // Rune's own BYOK secrets file (current and legacy homes). The list lives
        // in lib.rs so the plugin-tool profiles cannot drift from this one. The
        // user's `[sandbox.filesystem] denyRead` joins the same block. The
        // block is emitted after every file allow (see the profile template).
        let deny_reads: String = credential_deny_paths()
            .iter()
            .chain(self.config.deny_read_paths.iter())
            .map(|p| {
                format!(
                    "    (subpath \"{}\")",
                    escape_sb(&real_path(p).display().to_string())
                )
            })
            .collect::<Vec<_>>()
            .join("\n");

        let mut extra_read = String::new();
        for p in &self.config.extra_read_paths {
            extra_read.push_str(&format!(
                "(allow file-read* (subpath \"{}\"))\n",
                escape_sb(&p.display().to_string())
            ));
        }

        // Loopback stays open when the network is denied. A local dev server,
        // and curl or a headless browser against it, is how a page gets
        // verified — and a run that cannot bind 127.0.0.1 tries five times,
        // then verifies nothing (measured, session 01a067b8). All three verbs
        // are needed: `listen` is `network-inbound`, so bind alone leaves the
        // socket unusable (probed: without the inbound rule even a 127.0.0.1
        // listen fails). Seatbelt takes the LAST matching rule, so these follow
        // the deny.
        //
        // What this does NOT buy: Seatbelt's `localhost` filter is coarse, and
        // a process that binds 0.0.0.0 is admitted by it and is then reachable
        // from the local network (probed on a LAN address). Egress and DNS stay
        // denied either way, so nothing is pulled in or pushed out. The
        // wildcard bind itself is caught a layer up, by auto-containment's
        // `BEYOND_LOOPBACK_RE`, which refuses a command that asks to listen on
        // every interface. Do not describe this rule as "loopback only".
        let network_rule = if self.config.allow_network {
            "(allow network*)"
        } else {
            "(deny network*)\n\
             (allow network-bind (local ip \"localhost:*\"))\n\
             (allow network-inbound (local ip \"localhost:*\"))\n\
             (allow network-outbound (remote ip \"localhost:*\"))"
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

;; Writes confined to the workspace, cache, temp, and pseudo-devices
;; (/dev/null, /dev/urandom, tty, ...). Everything else stays read-only.
(allow file-read* file-write*
{writable}
)
(allow file-write* (subpath "/dev"))
{deny_write_rule}
{extra_read}

;; ...but never expose credential / secret stores, even to read. This block
;; comes LAST among the file rules on purpose: Seatbelt takes the last matching
;; rule, and a denied read inside the workspace (or an extra read root) must
;; beat the broad allows above it.
(deny file-read*
{deny_reads}
)
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
            .is_ok_and(|status| status.success())
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
            // Register for rune-tools' SIGTERM handler: an interrupt (Esc in
            // the CLI) must kill this group, not orphan it.
            crate::active_child::set(child_pid, true);

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
        assert!(!allowed.contains("(deny network*)"));
    }

    /// With the network denied, the loopback verbs are opened — bind, inbound
    /// and outbound, each written against localhost and each AFTER the deny,
    /// because Seatbelt takes the last matching rule. A local dev server and a
    /// curl against it work; egress and DNS do not.
    ///
    /// Note the profile does NOT prove "loopback only": Seatbelt's localhost
    /// filter admits a 0.0.0.0 bind, which auto-containment refuses instead.
    #[test]
    fn denied_network_keeps_loopback_open() {
        let denied = MacOsSandbox::new(cfg(PathBuf::from("/tmp/ws"), false)).seatbelt_profile();
        let deny_at = denied.find("(deny network*)").expect("deny rule");
        for rule in [
            "(allow network-bind (local ip \"localhost:*\"))",
            "(allow network-inbound (local ip \"localhost:*\"))",
            "(allow network-outbound (remote ip \"localhost:*\"))",
        ] {
            let at = denied
                .find(rule)
                .unwrap_or_else(|| panic!("missing {rule}"));
            assert!(at > deny_at, "{rule} must follow the deny");
        }
        // No rule names a wildcard host: outbound stays pinned to localhost, so
        // egress and DNS remain denied.
        assert!(!denied.contains("(remote ip \"*:"));
        assert!(!denied.contains("(local ip \"*:"));
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

    /// The policy's deny lists land in the profile: a denied read joins the
    /// credential block, a denied write gets its own block AFTER the write
    /// allow (last match wins), and an empty deny list emits NO write-deny
    /// rule at all — `(deny file-write*)` with no filter would deny every
    /// write, and a carve-out that is really a blanket ban is a broken profile.
    #[test]
    fn profile_carries_policy_deny_lists() {
        let mut config = cfg(PathBuf::from("/tmp/ws"), false);
        config.deny_read_paths = vec![PathBuf::from("/tmp/ws/private-notes")];
        config.deny_write_paths = vec![PathBuf::from("/tmp/ws/.rune/hooks")];
        let p = MacOsSandbox::new(config).seatbelt_profile();
        assert!(p.contains("private-notes"));
        let allow_at = p
            .find("(allow file-read* file-write*")
            .expect("write allow");
        let deny_at = p.find("(deny file-write*").expect("write deny");
        assert!(
            deny_at > allow_at,
            "the write deny must follow the write allow"
        );
        assert!(p.contains(".rune/hooks"));
        // The read deny must follow the write allow too: `/tmp/ws/private-notes`
        // sits inside the workspace, and an earlier deny would be overridden by
        // the later `(allow file-read* file-write* (subpath "/tmp/ws"))`.
        let read_deny_at = p.find("(deny file-read*").expect("read deny");
        assert!(
            read_deny_at > allow_at,
            "the read deny must follow the write allow (last match wins)"
        );
        let mut with_extra = cfg(PathBuf::from("/tmp/ws"), false);
        with_extra.extra_read_paths = vec![PathBuf::from("/opt/data")];
        with_extra.deny_read_paths = vec![PathBuf::from("/opt/data/keys")];
        let p2 = MacOsSandbox::new(with_extra).seatbelt_profile();
        let extra_at = p2
            .find("(allow file-read* (subpath \"/opt/data\"))")
            .expect("extra read");
        let read_deny_at2 = p2.find("(deny file-read*").expect("read deny");
        assert!(
            read_deny_at2 > extra_at,
            "the read deny must follow the extra read allows"
        );

        let plain = MacOsSandbox::new(cfg(PathBuf::from("/tmp/ws"), false)).seatbelt_profile();
        assert!(!plain.contains("(deny file-write*"));
    }

    #[tokio::test]
    async fn policy_denied_read_inside_workspace_is_blocked() {
        if !MacOsSandbox::is_available() {
            return;
        }
        let ws = tempfile::TempDir::new().unwrap();
        std::fs::create_dir_all(ws.path().join("secret")).unwrap();
        std::fs::write(ws.path().join("secret/token.txt"), "s3cret\n").unwrap();
        std::fs::write(ws.path().join("public.txt"), "hello\n").unwrap();
        let mut config = cfg(ws.path().to_path_buf(), false);
        config.deny_read_paths = vec![ws.path().join("secret")];
        let sb = MacOsSandbox::new(config);
        let r = sb
            .execute("cat secret/token.txt", None, Some(15_000))
            .await
            .expect("sandbox execute failed");
        assert_ne!(r.exit_code, 0, "a policy-denied read must fail");
        assert!(!r.stdout.contains("s3cret"), "stdout={:?}", r.stdout);
        // ...while an ordinary workspace read beside it still works.
        let ok = sb
            .execute("cat public.txt", None, Some(15_000))
            .await
            .expect("sandbox execute failed");
        assert_eq!(ok.exit_code, 0, "stderr={:?}", ok.stderr);
        assert!(ok.stdout.contains("hello"));
    }

    #[tokio::test]
    async fn policy_denied_write_inside_workspace_is_blocked() {
        if !MacOsSandbox::is_available() {
            return;
        }
        let ws = tempfile::TempDir::new().unwrap();
        std::fs::create_dir_all(ws.path().join(".rune/hooks")).unwrap();
        let mut config = cfg(ws.path().to_path_buf(), false);
        config.deny_write_paths = vec![ws.path().join(".rune/hooks")];
        let sb = MacOsSandbox::new(config);
        let r = sb
            .execute("echo hook > .rune/hooks/pre.sh", None, Some(15_000))
            .await
            .expect("sandbox execute failed");
        assert_ne!(r.exit_code, 0, "a policy-denied write must fail");
        assert!(!ws.path().join(".rune/hooks/pre.sh").exists());
        // ...while an ordinary workspace write beside it still works.
        let ok = sb
            .execute("echo fine > ordinary.txt", None, Some(15_000))
            .await
            .expect("sandbox execute failed");
        assert_eq!(ok.exit_code, 0, "stderr={:?}", ok.stderr);
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
        let probe = home.join(format!(".rune-sbx-write-probe-{}", std::process::id()));
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
