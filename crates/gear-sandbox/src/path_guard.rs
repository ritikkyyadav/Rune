use std::collections::HashMap;
use std::path::{Path, PathBuf};

use regex::Regex;
use tracing::warn;

use crate::error::SandboxError;

/// Security boundary that validates paths and commands before execution.
///
/// PathGuard ensures that file operations are confined to permitted directories
/// and that commands do not contain destructive patterns.
pub struct PathGuard {
    workspace_root: PathBuf,
    allowed_write: Vec<PathBuf>,
    blocked_paths: Vec<PathBuf>,
}

impl PathGuard {
    /// Create a new PathGuard for the given workspace root.
    ///
    /// By default, writes are allowed to:
    /// - The workspace root and its children
    /// - `~/.gear/cache`
    /// - `/tmp` (and `/private/tmp` on macOS)
    ///
    /// Blocked paths include system-critical directories that must never be
    /// written to by tool execution.
    pub fn new(workspace_root: PathBuf) -> Self {
        let home = dirs::home_dir().unwrap_or_else(|| PathBuf::from("/nonexistent"));
        let gear_cache = home.join(".gear").join("cache");

        let allowed_write = vec![
            workspace_root.clone(),
            gear_cache,
            PathBuf::from("/tmp"),
            #[cfg(target_os = "macos")]
            PathBuf::from("/private/tmp"),
        ];

        let blocked_paths = vec![
            PathBuf::from("/"),
            home.clone(),
            PathBuf::from("/etc"),
            PathBuf::from("/usr"),
            PathBuf::from("/var"),
            PathBuf::from("/bin"),
            PathBuf::from("/sbin"),
            PathBuf::from("/boot"),
            PathBuf::from("/root"),
            PathBuf::from("/opt"),
            PathBuf::from("/lib"),
            PathBuf::from("/lib64"),
            PathBuf::from("/proc"),
            PathBuf::from("/sys"),
            #[cfg(target_os = "macos")]
            PathBuf::from("/System"),
            #[cfg(target_os = "macos")]
            PathBuf::from("/Library"),
            #[cfg(target_os = "macos")]
            PathBuf::from("/Applications"),
            #[cfg(target_os = "macos")]
            PathBuf::from("/private/etc"),
            #[cfg(target_os = "macos")]
            PathBuf::from("/private/var"),
            home.join(".ssh"),
            home.join(".gnupg"),
            home.join(".aws"),
            home.join(".config"),
            home.join(".local"),
            home.join(".bash_history"),
            home.join(".zsh_history"),
        ];

        Self {
            workspace_root,
            allowed_write,
            blocked_paths,
        }
    }

    /// Extend the set of paths that are allowed for writing.
    pub fn allow_extra_write_paths(&mut self, paths: Vec<PathBuf>) {
        self.allowed_write.extend(paths);
    }

    /// Validate that the given path is safe for write operations.
    ///
    /// The path is canonicalized (or resolved via parent if it does not yet exist)
    /// and then checked against the blocked and allowed lists.
    pub fn validate_path(&self, path: &Path) -> Result<PathBuf, SandboxError> {
        // Canonicalize: if the file doesn't exist yet, canonicalize the parent.
        let canonical = if path.exists() {
            path.canonicalize().map_err(SandboxError::Io)?
        } else if let Some(parent) = path.parent() {
            if parent.exists() {
                let canonical_parent = parent.canonicalize().map_err(SandboxError::Io)?;
                canonical_parent.join(path.file_name().unwrap_or_default())
            } else {
                return Err(SandboxError::PathBlocked {
                    path: path.display().to_string(),
                    reason: "parent directory does not exist".into(),
                });
            }
        } else {
            return Err(SandboxError::PathBlocked {
                path: path.display().to_string(),
                reason: "cannot resolve path".into(),
            });
        };

        // Check blocked list — exact match means the path IS a blocked root.
        for blocked in &self.blocked_paths {
            if &canonical == blocked {
                return Err(SandboxError::PathBlocked {
                    path: canonical.display().to_string(),
                    reason: format!(
                        "path is a protected system location ({})",
                        blocked.display()
                    ),
                });
            }
        }

        // Check that the path falls under at least one allowed write root.
        let is_allowed = self
            .allowed_write
            .iter()
            .any(|allowed| canonical.starts_with(allowed));

        if !is_allowed {
            return Err(SandboxError::PathBlocked {
                path: canonical.display().to_string(),
                reason: "path is outside all allowed write directories".into(),
            });
        }

        Ok(canonical)
    }

    /// Strip quotes from a command string so patterns can match inside quoted args.
    fn strip_quotes(cmd: &str) -> String {
        cmd.replace(['\'', '"'], " ")
    }

    /// Validate a command string for dangerous patterns.
    ///
    /// This is a defence-in-depth heuristic — the sandbox itself is the primary
    /// containment boundary, but catching obviously destructive commands early
    /// provides a better error message and avoids unnecessary process spawns.
    ///
    /// The validator also handles:
    /// - Quoted arguments (patterns are matched after stripping quotes)
    /// - Variable expansion (`${VAR}`, `$(cmd)`)
    /// - Command chaining (`; rm`, `&& rm`, `|| rm`)
    pub fn validate_command(&self, cmd: &str) -> Result<(), SandboxError> {
        // First check for dangerous variable expansion patterns
        let expansion_patterns: Vec<(&str, Regex)> = vec![
            (
                "shell variable expansion with destructive command",
                Regex::new(r"\$\{[^}]*\}\s*&&\s*(?:rm|dd|mkfs|chmod|chown)").expect("valid regex"),
            ),
            (
                "command substitution with destructive command",
                Regex::new(r"\$\([^)]*(?:rm\s+-r|dd\s+if|mkfs|chmod\s+777)[^)]*\)")
                    .expect("valid regex"),
            ),
        ];

        for (description, pattern) in &expansion_patterns {
            if pattern.is_match(cmd) {
                warn!(
                    command = cmd,
                    pattern = *description,
                    "dangerous expansion blocked"
                );
                return Err(SandboxError::Violation(format!(
                    "command blocked: {description}"
                )));
            }
        }

        // Check for command chaining that introduces destructive commands
        let chaining_patterns: Vec<(&str, Regex)> = vec![
            (
                "chained rm via semicolon",
                Regex::new(r";\s*rm\s+.*-r").expect("valid regex"),
            ),
            (
                "chained rm via &&",
                Regex::new(r"&&\s*rm\s+.*-r").expect("valid regex"),
            ),
            (
                "chained rm via ||",
                Regex::new(r"\|\|\s*rm\s+.*-r").expect("valid regex"),
            ),
            (
                "chained destructive command via semicolon",
                Regex::new(r";\s*(?:dd\s+if|mkfs|chmod\s+777\s+/)").expect("valid regex"),
            ),
            (
                "chained destructive command via &&",
                Regex::new(r"&&\s*(?:dd\s+if|mkfs|chmod\s+777\s+/)").expect("valid regex"),
            ),
            (
                "chained destructive command via ||",
                Regex::new(r"\|\|\s*(?:dd\s+if|mkfs|chmod\s+777\s+/)").expect("valid regex"),
            ),
        ];

        for (description, pattern) in &chaining_patterns {
            if pattern.is_match(cmd) {
                warn!(
                    command = cmd,
                    pattern = *description,
                    "chained dangerous command blocked"
                );
                return Err(SandboxError::Violation(format!(
                    "command blocked: {description}"
                )));
            }
        }

        // Match against both the raw command and a quote-stripped version
        // so that patterns inside quotes are also detected.
        let unquoted = Self::strip_quotes(cmd);
        let variants = [cmd, unquoted.as_str()];

        let dangerous_patterns: Vec<(&str, Regex)> = vec![
            (
                "recursive forced deletion of root",
                Regex::new(r"rm\s+(-[a-zA-Z]*f[a-zA-Z]*\s+)?-[a-zA-Z]*r[a-zA-Z]*\s+/\s*$|rm\s+(-[a-zA-Z]*r[a-zA-Z]*\s+)?-[a-zA-Z]*f[a-zA-Z]*\s+/\s*$|rm\s+-rf\s+/\s*$")
                    .expect("valid regex"),
            ),
            (
                "recursive forced deletion of home directory",
                Regex::new(r"rm\s+.*-r.*\s+~/?\s*$|rm\s+.*-r.*\s+\$HOME/?")
                    .expect("valid regex"),
            ),
            (
                "overwriting disk device",
                Regex::new(r"(?:dd|>\s*)/dev/[sh]d[a-z]").expect("valid regex"),
            ),
            (
                "fork bomb",
                Regex::new(r":\(\)\s*\{\s*:\|:\s*&\s*\}\s*;").expect("valid regex"),
            ),
            (
                "writing to /etc/passwd or /etc/shadow",
                Regex::new(r">\s*/etc/(?:passwd|shadow)").expect("valid regex"),
            ),
            (
                "chmod 777 on root",
                Regex::new(r"chmod\s+.*777\s+/\s*$").expect("valid regex"),
            ),
            (
                "disabling firewall",
                Regex::new(r"(?:iptables|ufw|pfctl)\s+.*(?:flush|disable|stop)")
                    .expect("valid regex"),
            ),
            (
                "curl piped to shell",
                Regex::new(r"curl\s+.*\|\s*(?:ba)?sh").expect("valid regex"),
            ),
            (
                "wget piped to shell",
                Regex::new(r"wget\s+.*\|\s*(?:ba)?sh").expect("valid regex"),
            ),
            (
                "mkfs on a device",
                Regex::new(r"mkfs").expect("valid regex"),
            ),
        ];

        for (description, pattern) in &dangerous_patterns {
            for variant in &variants {
                if pattern.is_match(variant) {
                    warn!(
                        command = cmd,
                        pattern = *description,
                        "dangerous command blocked"
                    );
                    return Err(SandboxError::Violation(format!(
                        "command blocked: {description}"
                    )));
                }
            }
        }

        Ok(())
    }

    /// Build a curated environment map for spawned processes.
    ///
    /// Only safe, workspace-scoped variables are included. This prevents
    /// credential leakage from the parent environment.
    pub fn curate_env(&self) -> HashMap<String, String> {
        let mut env = HashMap::new();

        // Propagate only safe variables from the current environment.
        let safe_vars = ["PATH", "HOME", "TMPDIR", "USER", "LANG", "TERM", "SHELL"];
        for var in &safe_vars {
            if let Ok(val) = std::env::var(var) {
                env.insert((*var).to_string(), val);
            }
        }
        // Windows needs more than PATH to run anything at all: `cmd.exe`
        // refuses to start without `SystemRoot`, `PATHEXT` is what makes
        // `foo` find `foo.exe`, and `TEMP`/`TMP` are the Windows spelling of
        // `TMPDIR`. The caller does `env_clear()` before applying this map, so
        // an omission here is not "less environment" — it is a shell that does
        // not start (P10.2).
        if cfg!(windows) {
            let win_vars = [
                "SystemRoot",
                "SystemDrive",
                "windir",
                "COMSPEC",
                "ComSpec",
                "PATHEXT",
                "TEMP",
                "TMP",
                "USERPROFILE",
                "USERNAME",
                "APPDATA",
                "LOCALAPPDATA",
                "PROGRAMFILES",
                "PROGRAMDATA",
                "NUMBER_OF_PROCESSORS",
                "PROCESSOR_ARCHITECTURE",
                "OS",
            ];
            for var in &win_vars {
                if let Ok(val) = std::env::var(var) {
                    env.insert((*var).to_string(), val);
                }
            }
        }

        // Workspace-scoped overrides.
        env.insert(
            "GEAR_WORKSPACE".to_string(),
            self.workspace_root.display().to_string(),
        );
        env.insert("NO_COLOR".to_string(), "1".to_string());

        env
    }

    /// Return the workspace root this guard was created for.
    pub fn workspace_root(&self) -> &Path {
        &self.workspace_root
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_rm_rf_root() {
        let guard = PathGuard::new(PathBuf::from("/tmp/workspace"));
        assert!(guard.validate_command("rm -rf /").is_err());
    }

    #[test]
    fn rejects_rm_rf_home() {
        let guard = PathGuard::new(PathBuf::from("/tmp/workspace"));
        assert!(guard.validate_command("rm -rf ~/").is_err());
    }

    #[test]
    fn accepts_safe_command() {
        let guard = PathGuard::new(PathBuf::from("/tmp/workspace"));
        assert!(guard.validate_command("ls -la").is_ok());
        assert!(guard.validate_command("cargo build").is_ok());
    }

    #[test]
    fn rejects_quoted_rm_rf() {
        let guard = PathGuard::new(PathBuf::from("/tmp/workspace"));
        // rm -rf inside quotes should still be caught
        assert!(guard.validate_command(r#"sh -c "rm -rf /""#).is_err());
    }

    #[test]
    fn rejects_chained_rm() {
        let guard = PathGuard::new(PathBuf::from("/tmp/workspace"));
        assert!(guard.validate_command("echo hello; rm -rf /tmp").is_err());
        assert!(guard.validate_command("true && rm -rf /tmp").is_err());
        assert!(guard.validate_command("false || rm -rf /tmp").is_err());
    }

    #[test]
    fn rejects_variable_expansion_attacks() {
        let guard = PathGuard::new(PathBuf::from("/tmp/workspace"));
        assert!(guard.validate_command("$(rm -rf /tmp/data)").is_err());
    }

    #[test]
    fn curate_env_contains_workspace() {
        let guard = PathGuard::new(PathBuf::from("/tmp/ws"));
        let env = guard.curate_env();
        assert_eq!(env.get("GEAR_WORKSPACE").unwrap(), "/tmp/ws");
        assert_eq!(env.get("NO_COLOR").unwrap(), "1");
    }
}
