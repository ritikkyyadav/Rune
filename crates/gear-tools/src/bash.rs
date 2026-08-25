use regex::Regex;
use serde::{Deserialize, Serialize};
use std::path::Path;
use std::process::Stdio;
use std::sync::OnceLock;
use tokio::io::AsyncReadExt;
use tokio::process::Command;
use tokio::time::{Duration, timeout};

use crate::error::ToolError;

const DEFAULT_TIMEOUT_MS: u64 = 120_000;
const MAX_OUTPUT_BYTES: usize = 512 * 1024; // 500 KB total per stream
// When output exceeds the cap, keep both ends: build/test tools print the
// failure summary at the END, so a head-only cut hides exactly what the
// model needs to see.
const TRUNCATE_HEAD_BYTES: usize = 384 * 1024;
const TRUNCATE_TAIL_BYTES: usize = 128 * 1024;

#[derive(Debug, Deserialize)]
pub struct BashInput {
    pub command: String,
    pub timeout_ms: Option<u64>,
}

#[derive(Debug, Serialize)]
pub struct BashOutput {
    pub stdout: String,
    pub stderr: String,
    pub exit_code: Option<i32>,
    pub timed_out: bool,
    pub truncated: bool,
    /// Whether OS-level isolation was ACTUALLY active for this run. The
    /// sandbox factory silently falls back to a path-guard-only executor when
    /// seatbelt/bwrap is missing; dropping that fact here is how "sandboxed"
    /// became a lie upstream. false for the plain (non --sandbox) path too.
    pub sandboxed: bool,
}

/// Destructive-command guard. Anchored so it only blocks commands whose
/// TARGET is the filesystem root / a raw disk device — `rm -rf /tmp/foo` and
/// `dd if=/dev/zero of=./bench.img` are legitimate and must pass.
fn blocked_reason(command: &str) -> Option<&'static str> {
    static PATTERNS: OnceLock<Vec<(Regex, &'static str)>> = OnceLock::new();
    let patterns = PATTERNS.get_or_init(|| {
        vec![
            (
                // rm with recursive+force flags aimed at "/" or "/*" (not /path)
                Regex::new(
                    r"(?i)\brm\s+(-[a-z-]+\s+)*-?-?[a-z]*[rf][a-z]*\s+(--\s+)?/\*?\s*($|[;&|])",
                )
                .unwrap(),
                "recursive delete of the filesystem root",
            ),
            (
                Regex::new(r"(?i)\bchmod\s+(-[a-z]+\s+)*-?r\S*\s+\d+\s+/\s*($|[;&|])").unwrap(),
                "recursive chmod of the filesystem root",
            ),
            (
                // fork bomb
                Regex::new(r":\(\)\s*\{\s*:\|:&\s*\}\s*;\s*:").unwrap(),
                "fork bomb",
            ),
            (
                // writing to a raw disk device (dd of=, or shell redirect)
                Regex::new(r"(?i)(of=|>\s*)/dev/(r?disk|sd[a-z]|hd[a-z]|nvme)").unwrap(),
                "raw write to a disk device",
            ),
            (
                Regex::new(r"(?i)\bmkfs(\.[a-z0-9]+)?\s").unwrap(),
                "filesystem format command",
            ),
        ]
    });
    for (re, reason) in patterns {
        if re.is_match(command) {
            return Some(reason);
        }
    }
    None
}

pub async fn execute(input: BashInput, workspace_root: &Path) -> Result<BashOutput, ToolError> {
    if let Some(reason) = blocked_reason(&input.command) {
        return Err(ToolError::CommandFailed(format!(
            "Command blocked: {reason}"
        )));
    }

    let timeout_ms = input.timeout_ms.unwrap_or(DEFAULT_TIMEOUT_MS);

    // Inherit the full parent environment (like Claude Code / Codex): stripping
    // it breaks SSH agents, proxies, toolchain managers (nvm/pyenv/cargo), and
    // anything the user exported. Only guarantee the basics have sane values.
    let mut cmd = Command::new("bash");
    cmd.arg("-c")
        .arg(&input.command)
        .current_dir(workspace_root)
        .env(
            "TERM",
            std::env::var("TERM").unwrap_or_else(|_| "xterm-256color".into()),
        )
        .env(
            "LANG",
            std::env::var("LANG").unwrap_or_else(|_| "en_US.UTF-8".into()),
        )
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    // Put the child in its own process group so a timeout can kill the whole
    // tree (pipelines, subshells, spawned servers) — not just the bash leader.
    #[cfg(unix)]
    cmd.process_group(0);

    let mut child = cmd
        .spawn()
        .map_err(|e| ToolError::CommandFailed(format!("Failed to spawn bash: {e}")))?;

    let child_pid = child.id();

    let mut stdout = child.stdout.take();
    let mut stderr = child.stderr.take();

    let result = timeout(Duration::from_millis(timeout_ms), async {
        let mut stdout_buf = Vec::new();
        let mut stderr_buf = Vec::new();

        // Drain BOTH pipes concurrently. Reading them sequentially deadlocks:
        // if the child fills the ~64KB stderr pipe buffer while we're still
        // blocked on stdout, it stalls forever (classic with compilers and
        // test runners that stream progress to stderr).
        let stdout_fut = async {
            if let Some(ref mut out) = stdout {
                out.read_to_end(&mut stdout_buf).await.ok();
            }
        };
        let stderr_fut = async {
            if let Some(ref mut err) = stderr {
                err.read_to_end(&mut stderr_buf).await.ok();
            }
        };
        tokio::join!(stdout_fut, stderr_fut);

        let status = child.wait().await;
        (stdout_buf, stderr_buf, status)
    })
    .await;

    match result {
        Ok((stdout_buf, stderr_buf, status)) => {
            let truncated =
                stdout_buf.len() > MAX_OUTPUT_BYTES || stderr_buf.len() > MAX_OUTPUT_BYTES;

            let stdout = truncate_output(&stdout_buf);
            let stderr = truncate_output(&stderr_buf);

            let exit_code = status.ok().and_then(|s| s.code());

            Ok(BashOutput {
                stdout,
                stderr,
                exit_code,
                timed_out: false,
                truncated,
                sandboxed: false,
            })
        }
        Err(_) => {
            // Timeout — kill the whole process group, then the leader as a
            // fallback, so grandchildren don't linger holding ports/files.
            kill_process_group(child_pid);
            child.kill().await.ok();
            Ok(BashOutput {
                stdout: String::new(),
                stderr: format!("Command timed out after {timeout_ms}ms"),
                exit_code: None,
                timed_out: true,
                truncated: false,
                sandboxed: false,
            })
        }
    }
}

/// SIGKILL an entire process group (unix). Best-effort — the caller still
/// kills the direct child afterward.
pub(crate) fn kill_process_group(pid: Option<u32>) {
    #[cfg(unix)]
    if let Some(pid) = pid {
        unsafe {
            libc::kill(-(pid as i32), libc::SIGKILL);
        }
    }
    #[cfg(not(unix))]
    let _ = pid;
}

/// Execute a bash command through the platform sandbox (macOS sandbox-exec / Linux bwrap).
pub async fn execute_sandboxed(
    input: BashInput,
    workspace_root: &Path,
) -> Result<BashOutput, ToolError> {
    use gear_sandbox::{SandboxConfig, create_sandbox};

    if let Some(reason) = blocked_reason(&input.command) {
        return Err(ToolError::CommandFailed(format!(
            "Command blocked: {reason}"
        )));
    }

    let config = SandboxConfig {
        workspace_root: workspace_root.to_path_buf(),
        timeout_ms: input.timeout_ms.unwrap_or(DEFAULT_TIMEOUT_MS),
        allow_network: false,
        ..Default::default()
    };

    let sandbox = create_sandbox(config);
    // The factory may have silently fallen back to the path-guard-only
    // executor — report what actually ran, not what was asked for.
    let os_isolated = sandbox.name() != "noop";

    match sandbox
        .execute(&input.command, Some(workspace_root), input.timeout_ms)
        .await
    {
        Ok(result) => {
            let truncated =
                result.stdout.len() > MAX_OUTPUT_BYTES || result.stderr.len() > MAX_OUTPUT_BYTES;

            Ok(BashOutput {
                stdout: truncate_output(result.stdout.as_bytes()),
                stderr: truncate_output(result.stderr.as_bytes()),
                exit_code: Some(result.exit_code),
                timed_out: false,
                truncated,
                sandboxed: result.sandboxed,
            })
        }
        Err(gear_sandbox::SandboxError::Timeout(ms)) => Ok(BashOutput {
            stdout: String::new(),
            stderr: format!(
                "Command timed out after {ms}ms (sandboxed). If it needs network access \
                 (installs, git push/pull, curl), re-run with network: true."
            ),
            exit_code: None,
            timed_out: true,
            truncated: false,
            sandboxed: os_isolated,
        }),
        Err(e) => Err(ToolError::CommandFailed(e.to_string())),
    }
}

/// Byte-cap a stream keeping the head AND the tail with an explicit elision
/// marker. `from_utf8_lossy` absorbs any split multi-byte boundary.
fn truncate_output(buf: &[u8]) -> String {
    if buf.len() <= MAX_OUTPUT_BYTES {
        return String::from_utf8_lossy(buf).to_string();
    }
    let head = String::from_utf8_lossy(&buf[..TRUNCATE_HEAD_BYTES]);
    let tail = String::from_utf8_lossy(&buf[buf.len() - TRUNCATE_TAIL_BYTES..]);
    let omitted = buf.len() - TRUNCATE_HEAD_BYTES - TRUNCATE_TAIL_BYTES;
    format!("{head}\n… [{omitted} bytes omitted — output exceeded the 512KB cap] …\n{tail}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[tokio::test]
    async fn runs_simple_command() {
        let tmp = TempDir::new().unwrap();
        let output = execute(
            BashInput {
                command: "echo hello".to_string(),
                timeout_ms: None,
            },
            tmp.path(),
        )
        .await
        .unwrap();

        assert_eq!(output.stdout.trim(), "hello");
        assert_eq!(output.exit_code, Some(0));
        assert!(!output.timed_out);
    }

    #[tokio::test]
    async fn captures_stderr() {
        let tmp = TempDir::new().unwrap();
        let output = execute(
            BashInput {
                command: "echo err >&2".to_string(),
                timeout_ms: None,
            },
            tmp.path(),
        )
        .await
        .unwrap();

        assert_eq!(output.stderr.trim(), "err");
    }

    #[tokio::test]
    async fn reports_exit_code() {
        let tmp = TempDir::new().unwrap();
        let output = execute(
            BashInput {
                command: "exit 42".to_string(),
                timeout_ms: None,
            },
            tmp.path(),
        )
        .await
        .unwrap();

        assert_eq!(output.exit_code, Some(42));
    }

    #[tokio::test]
    async fn times_out() {
        let tmp = TempDir::new().unwrap();
        let output = execute(
            BashInput {
                command: "sleep 10".to_string(),
                timeout_ms: Some(100),
            },
            tmp.path(),
        )
        .await
        .unwrap();

        assert!(output.timed_out);
        assert_eq!(output.exit_code, None);
    }

    #[tokio::test]
    async fn blocks_dangerous_commands() {
        let tmp = TempDir::new().unwrap();
        for cmd in ["rm -rf /", "rm -rf /*", "sudo rm -fr / ; echo done"] {
            let result = execute(
                BashInput {
                    command: cmd.to_string(),
                    timeout_ms: None,
                },
                tmp.path(),
            )
            .await;
            assert!(
                matches!(result, Err(ToolError::CommandFailed(_))),
                "expected block: {cmd}"
            );
        }
    }

    #[tokio::test]
    async fn allows_scoped_recursive_delete() {
        let tmp = TempDir::new().unwrap();
        std::fs::create_dir_all(tmp.path().join("junk/sub")).unwrap();
        // The old substring blocklist rejected ANY "rm -rf /<path>" — a
        // constant false positive for legitimate cleanups.
        let cmd = format!("rm -rf {}/junk && echo cleaned", tmp.path().display());
        let output = execute(
            BashInput {
                command: cmd,
                timeout_ms: None,
            },
            tmp.path(),
        )
        .await
        .unwrap();
        assert_eq!(output.stdout.trim(), "cleaned");
        assert_eq!(output.exit_code, Some(0));
        assert!(!tmp.path().join("junk").exists());
    }

    #[tokio::test]
    async fn no_deadlock_on_large_stderr() {
        let tmp = TempDir::new().unwrap();
        // >64KB to stderr while stdout stays open: the old sequential
        // read_to_end(stdout)-then-stderr deadlocked here until timeout.
        let output = execute(
            BashInput {
                command: "for i in $(seq 1 4000); do echo 'stderr line padding padding padding' >&2; done; echo done-stdout".to_string(),
                timeout_ms: Some(15_000),
            },
            tmp.path(),
        )
        .await
        .unwrap();

        assert!(!output.timed_out, "large stderr must not deadlock/time out");
        assert_eq!(output.stdout.trim(), "done-stdout");
        assert!(output.stderr.len() > 64 * 1024);
    }

    #[tokio::test]
    async fn timeout_kills_process_group() {
        let tmp = TempDir::new().unwrap();
        let marker = tmp.path().join("grandchild-alive");
        // A grandchild that would outlive a leader-only kill and prove itself
        // by writing a marker file after the timeout fires.
        let cmd = format!("(sleep 1 && touch {}) & wait", marker.display());
        let output = execute(
            BashInput {
                command: cmd,
                timeout_ms: Some(200),
            },
            tmp.path(),
        )
        .await
        .unwrap();
        assert!(output.timed_out);
        tokio::time::sleep(Duration::from_millis(1300)).await;
        assert!(
            !marker.exists(),
            "grandchild survived the timeout — process group was not killed"
        );
    }

    #[tokio::test]
    async fn inherits_parent_environment() {
        let tmp = TempDir::new().unwrap();
        // SAFETY: test-only env mutation; tests in this module are async but
        // this var is unique to this test.
        unsafe { std::env::set_var("GEAR_BASH_ENV_PROBE", "inherited-42") };
        let output = execute(
            BashInput {
                command: "echo $GEAR_BASH_ENV_PROBE".to_string(),
                timeout_ms: None,
            },
            tmp.path(),
        )
        .await
        .unwrap();
        unsafe { std::env::remove_var("GEAR_BASH_ENV_PROBE") };
        assert_eq!(output.stdout.trim(), "inherited-42");
    }

    #[tokio::test]
    async fn uses_workspace_as_cwd() {
        let tmp = TempDir::new().unwrap();
        std::fs::write(tmp.path().join("marker.txt"), "found").unwrap();

        let output = execute(
            BashInput {
                command: "cat marker.txt".to_string(),
                timeout_ms: None,
            },
            tmp.path(),
        )
        .await
        .unwrap();

        assert_eq!(output.stdout.trim(), "found");
    }

    #[test]
    fn truncation_keeps_head_and_tail() {
        let mut buf = Vec::new();
        buf.extend_from_slice(b"HEAD-MARKER\n");
        buf.extend(std::iter::repeat_n(b'x', MAX_OUTPUT_BYTES + 4096));
        buf.extend_from_slice(b"\nTAIL-MARKER");
        let out = truncate_output(&buf);
        assert!(out.starts_with("HEAD-MARKER"));
        assert!(out.ends_with("TAIL-MARKER"));
        assert!(out.contains("bytes omitted"));
    }

    #[test]
    fn blocklist_precision() {
        // Blocked: root-targeted destruction
        assert!(blocked_reason("rm -rf /").is_some());
        assert!(blocked_reason("rm -fr /*").is_some());
        assert!(blocked_reason("rm -rf / && echo gone").is_some());
        assert!(blocked_reason("chmod -R 777 /").is_some());
        assert!(blocked_reason(":(){ :|:& };:").is_some());
        assert!(blocked_reason("dd if=/dev/zero of=/dev/disk0").is_some());
        assert!(blocked_reason("echo hi > /dev/sda").is_some());
        assert!(blocked_reason("mkfs.ext4 /dev/sdb1").is_some());

        // Allowed: scoped/legitimate commands the old substring check rejected
        assert!(blocked_reason("rm -rf /tmp/build-cache").is_none());
        assert!(blocked_reason("rm -rf /Users/me/project/node_modules").is_none());
        assert!(blocked_reason("rm -rf ./dist").is_none());
        assert!(blocked_reason("dd if=/dev/urandom of=./random.bin count=1").is_none());
        assert!(blocked_reason("echo test > /dev/null").is_none());
        assert!(blocked_reason("chmod -R 755 ./scripts").is_none());
        assert!(blocked_reason("git rm -rf --cached .").is_none());
    }
}
