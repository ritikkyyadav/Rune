use serde::{Deserialize, Serialize};
use std::path::Path;
use std::process::Stdio;
use tokio::io::AsyncReadExt;
use tokio::process::Command;
use tokio::time::{timeout, Duration};

use crate::error::ToolError;

const DEFAULT_TIMEOUT_MS: u64 = 120_000;
const MAX_OUTPUT_BYTES: usize = 512 * 1024; // 500 KB

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
}

const BLOCKED_PATTERNS: &[&str] = &[
    "rm -rf /",
    "rm -rf /*",
    ":(){ :|:& };:",
    "dd if=/dev/",
    "mkfs.",
    "> /dev/sda",
    "chmod -R 777 /",
];

pub async fn execute(input: BashInput, workspace_root: &Path) -> Result<BashOutput, ToolError> {
    // Check blocklist
    let cmd_lower = input.command.to_lowercase();
    for pattern in BLOCKED_PATTERNS {
        if cmd_lower.contains(pattern) {
            return Err(ToolError::CommandFailed(format!(
                "Command blocked: contains dangerous pattern '{pattern}'"
            )));
        }
    }

    let timeout_ms = input.timeout_ms.unwrap_or(DEFAULT_TIMEOUT_MS);

    let mut child = Command::new("bash")
        .arg("-c")
        .arg(&input.command)
        .current_dir(workspace_root)
        .env_clear()
        .env("PATH", std::env::var("PATH").unwrap_or_default())
        .env("HOME", std::env::var("HOME").unwrap_or_default())
        .env("TERM", "xterm-256color")
        .env("LANG", "en_US.UTF-8")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| ToolError::CommandFailed(format!("Failed to spawn bash: {e}")))?;

    let result = timeout(Duration::from_millis(timeout_ms), async {
        let mut stdout_buf = Vec::new();
        let mut stderr_buf = Vec::new();

        if let Some(mut stdout) = child.stdout.take() {
            stdout.read_to_end(&mut stdout_buf).await.ok();
        }
        if let Some(mut stderr) = child.stderr.take() {
            stderr.read_to_end(&mut stderr_buf).await.ok();
        }

        let status = child.wait().await;
        (stdout_buf, stderr_buf, status)
    })
    .await;

    match result {
        Ok((stdout_buf, stderr_buf, status)) => {
            let truncated =
                stdout_buf.len() > MAX_OUTPUT_BYTES || stderr_buf.len() > MAX_OUTPUT_BYTES;

            let stdout = truncate_string(&stdout_buf, MAX_OUTPUT_BYTES);
            let stderr = truncate_string(&stderr_buf, MAX_OUTPUT_BYTES);

            let exit_code = status.ok().and_then(|s| s.code());

            Ok(BashOutput {
                stdout,
                stderr,
                exit_code,
                timed_out: false,
                truncated,
            })
        }
        Err(_) => {
            // Timeout — kill the process
            child.kill().await.ok();
            Ok(BashOutput {
                stdout: String::new(),
                stderr: format!("Command timed out after {timeout_ms}ms"),
                exit_code: None,
                timed_out: true,
                truncated: false,
            })
        }
    }
}

/// Execute a bash command through the platform sandbox (macOS sandbox-exec / Linux bwrap).
pub async fn execute_sandboxed(input: BashInput, workspace_root: &Path) -> Result<BashOutput, ToolError> {
    use alan_sandbox::{create_sandbox, SandboxConfig};

    let config = SandboxConfig {
        workspace_root: workspace_root.to_path_buf(),
        timeout_ms: input.timeout_ms.unwrap_or(DEFAULT_TIMEOUT_MS),
        allow_network: false,
        ..Default::default()
    };

    let sandbox = create_sandbox(config);

    match sandbox
        .execute(
            &input.command,
            Some(workspace_root),
            input.timeout_ms,
        )
        .await
    {
        Ok(result) => {
            let truncated = result.stdout.len() > MAX_OUTPUT_BYTES
                || result.stderr.len() > MAX_OUTPUT_BYTES;

            Ok(BashOutput {
                stdout: if result.stdout.len() > MAX_OUTPUT_BYTES {
                    result.stdout[..MAX_OUTPUT_BYTES].to_string()
                } else {
                    result.stdout
                },
                stderr: if result.stderr.len() > MAX_OUTPUT_BYTES {
                    result.stderr[..MAX_OUTPUT_BYTES].to_string()
                } else {
                    result.stderr
                },
                exit_code: Some(result.exit_code),
                timed_out: false,
                truncated,
            })
        }
        Err(alan_sandbox::SandboxError::Timeout(ms)) => Ok(BashOutput {
            stdout: String::new(),
            stderr: format!("Command timed out after {ms}ms"),
            exit_code: None,
            timed_out: true,
            truncated: false,
        }),
        Err(e) => Err(ToolError::CommandFailed(e.to_string())),
    }
}

fn truncate_string(buf: &[u8], max: usize) -> String {
    let slice = if buf.len() > max { &buf[..max] } else { buf };
    String::from_utf8_lossy(slice).to_string()
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
        let result = execute(
            BashInput {
                command: "rm -rf /".to_string(),
                timeout_ms: None,
            },
            tmp.path(),
        )
        .await;

        assert!(matches!(result, Err(ToolError::CommandFailed(_))));
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
}
