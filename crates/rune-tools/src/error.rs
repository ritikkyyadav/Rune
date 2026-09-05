use thiserror::Error;

#[derive(Debug, Error)]
pub enum ToolError {
    #[error("IO error at {path}: {detail}")]
    Io { path: String, detail: String },

    #[error("File too large: {path} ({size} bytes, max {max})")]
    FileTooLarge { path: String, size: u64, max: u64 },

    #[error("Path escape: {path} is outside workspace {workspace}")]
    PathEscape { path: String, workspace: String },

    #[error("Invalid arguments: {0}")]
    InvalidArgs(String),

    #[error("Timeout after {0}ms")]
    Timeout(u64),

    #[error("Command failed: {0}")]
    CommandFailed(String),
}
