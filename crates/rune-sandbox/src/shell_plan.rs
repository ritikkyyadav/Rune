//! Long-lived shells use the same profiles and environment as foreground ones.
use crate::{PathGuard, SandboxConfig, SandboxError};
use serde::Serialize;
use std::collections::HashMap;

#[derive(Debug, Serialize)]
pub struct ShellPlan {
    pub program: String,
    pub args: Vec<String>,
    pub env: HashMap<String, String>,
    pub sandboxed: bool,
}

pub fn plan_shell(config: SandboxConfig, command: &str) -> Result<ShellPlan, SandboxError> {
    let mut guard = PathGuard::new(config.workspace_root.clone());
    guard.allow_extra_write_paths(config.extra_write_paths.clone());
    guard.deny_extra_write_paths(config.deny_write_paths.clone());
    guard.validate_command(command)?;
    let mut env = guard.curate_env();
    env.extend(config.env_overrides.clone());
    #[cfg(target_os = "macos")]
    {
        use crate::macos::MacOsSandbox;
        if MacOsSandbox::is_available() {
            let profile = MacOsSandbox::new(config).seatbelt_profile();
            return Ok(ShellPlan {
                program: "sandbox-exec".into(),
                args: vec![
                    "-p".into(),
                    profile,
                    "/bin/sh".into(),
                    "-c".into(),
                    command.into(),
                ],
                env,
                sandboxed: true,
            });
        }
    }
    #[cfg(target_os = "linux")]
    {
        use crate::linux::LinuxSandbox;
        if LinuxSandbox::is_available() {
            let cwd = config.workspace_root.clone();
            let args = LinuxSandbox::new(config).bwrap_args(command, &cwd);
            return Ok(ShellPlan {
                program: "bwrap".into(),
                args,
                env,
                sandboxed: true,
            });
        }
    }
    Err(SandboxError::Violation(
        "OS isolation is unavailable for a background shell".into(),
    ))
}
