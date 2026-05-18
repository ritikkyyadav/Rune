use thiserror::Error;

use crate::protocol::error_codes;

#[derive(Error, Debug)]
pub enum AlanError {
    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),

    #[error("Database error: {0}")]
    Database(#[from] rusqlite::Error),

    #[error("Serialization error: {0}")]
    Serialization(#[from] serde_json::Error),

    #[error("Session not found: {0}")]
    SessionNotFound(String),

    #[error("Permission denied: {0}")]
    PermissionDenied(String),

    #[error("Tool execution failed: {tool} - {message}")]
    ToolExecFailed { tool: String, message: String },

    #[error("Context overflow: {0}")]
    ContextOverflow(String),

    #[error("Provider error: {provider} - {message}")]
    ProviderError { provider: String, message: String },

    #[error("Sandbox violation: {0}")]
    SandboxViolation(String),

    #[error("Protocol error: {0}")]
    Protocol(String),

    #[error("Config error: {0}")]
    Config(String),
}

impl AlanError {
    pub fn to_rpc_code(&self) -> i32 {
        match self {
            Self::Io(_) => error_codes::INTERNAL_ERROR,
            Self::Database(_) => error_codes::INTERNAL_ERROR,
            Self::Serialization(_) => error_codes::PARSE_ERROR,
            Self::SessionNotFound(_) => error_codes::SESSION_NOT_FOUND,
            Self::PermissionDenied(_) => error_codes::PERMISSION_DENIED,
            Self::ToolExecFailed { .. } => error_codes::TOOL_EXEC_FAILED,
            Self::ContextOverflow(_) => error_codes::CONTEXT_OVERFLOW,
            Self::ProviderError { .. } => error_codes::PROVIDER_ERROR,
            Self::SandboxViolation(_) => error_codes::SANDBOX_VIOLATION,
            Self::Protocol(_) => error_codes::INVALID_REQUEST,
            Self::Config(_) => error_codes::INTERNAL_ERROR,
        }
    }
}
