use thiserror::Error;

#[derive(Error, Debug)]
pub enum SandboxError {
    #[error("Failed to spawn process: {0}")]
    SpawnFailed(String),

    #[error("Sandbox violation: {0}")]
    Violation(String),

    #[error("Process timed out after {0}ms")]
    Timeout(u64),

    #[error("Path blocked: {path} — {reason}")]
    PathBlocked { path: String, reason: String },

    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),
}
