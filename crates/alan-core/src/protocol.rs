use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

// ─── JSON-RPC 2.0 Base Types ───

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JsonRpcRequest {
    pub jsonrpc: String,
    pub id: RequestId,
    pub method: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub params: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub enum RequestId {
    String(String),
    Number(i64),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JsonRpcResponse {
    pub jsonrpc: String,
    pub id: Option<RequestId>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<JsonRpcError>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JsonRpcError {
    pub code: i32,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JsonRpcNotification {
    pub jsonrpc: String,
    pub method: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub params: Option<serde_json::Value>,
}

// ─── Error Codes ───

pub mod error_codes {
    pub const PARSE_ERROR: i32 = -32700;
    pub const INVALID_REQUEST: i32 = -32600;
    pub const METHOD_NOT_FOUND: i32 = -32601;
    pub const INVALID_PARAMS: i32 = -32602;
    pub const INTERNAL_ERROR: i32 = -32603;
    // Custom
    pub const SESSION_NOT_FOUND: i32 = -32000;
    pub const PERMISSION_DENIED: i32 = -32001;
    pub const TOOL_EXEC_FAILED: i32 = -32002;
    pub const CONTEXT_OVERFLOW: i32 = -32003;
    pub const PROVIDER_ERROR: i32 = -32004;
    pub const SANDBOX_VIOLATION: i32 = -32005;
}

// ─── Domain Types ───

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionInfo {
    pub id: Uuid,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub workspace_root: String,
    pub model: String,
    pub event_count: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", content = "payload")]
pub enum SessionEvent {
    UserMessage {
        content: String,
    },
    AssistantMessage {
        content: String,
    },
    ToolCall {
        call_id: String,
        tool_name: String,
        args: serde_json::Value,
    },
    ToolResult {
        call_id: String,
        tool_name: String,
        result: serde_json::Value,
        duration_ms: u64,
        exit_code: Option<i32>,
    },
    SystemNote {
        content: String,
    },
    Checkpoint {
        summary: String,
    },
    PlanCreated {
        plan: Plan,
    },
    PlanUpdated {
        plan: Plan,
    },
    StepCompleted {
        plan_id: String,
        step_index: usize,
        result: StepResult,
    },
}

// ─── Plan Types ───

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Plan {
    pub id: String,
    pub steps: Vec<Step>,
    pub status: PlanStatus,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Step {
    pub index: usize,
    pub description: String,
    pub tools_hint: Vec<String>,
    pub success_criteria: String,
    pub status: StepStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<StepResult>,
    pub depends_on: Vec<usize>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum PlanStatus {
    Active,
    Completed,
    Failed,
    Cancelled,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum StepStatus {
    Pending,
    Running,
    Completed,
    Failed,
    Skipped,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StepResult {
    pub success: bool,
    pub summary: String,
    pub artifacts: Vec<String>,
    pub error: Option<String>,
}

// ─── Response Helpers ───

impl JsonRpcResponse {
    pub fn success(id: Option<RequestId>, result: serde_json::Value) -> Self {
        Self {
            jsonrpc: "2.0".to_string(),
            id,
            result: Some(result),
            error: None,
        }
    }

    pub fn error(id: Option<RequestId>, code: i32, message: String) -> Self {
        Self {
            jsonrpc: "2.0".to_string(),
            id,
            result: None,
            error: Some(JsonRpcError {
                code,
                message,
                data: None,
            }),
        }
    }

    /// Replace the `id` field, useful for helper functions that build a response
    /// before the caller's request id is available.
    pub fn with_id(mut self, id: Option<RequestId>) -> Self {
        self.id = id;
        self
    }
}
