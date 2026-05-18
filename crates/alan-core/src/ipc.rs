use std::path::{Path, PathBuf};
use std::sync::Arc;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::{UnixListener, UnixStream};
use tokio::sync::Mutex;
use tracing::{debug, error, info, warn};

use crate::error::AlanError;
use crate::protocol::{error_codes, JsonRpcRequest, JsonRpcResponse, SessionEvent};
use crate::session::SessionManager;

// ─── Shared Context ───

/// State shared across all IPC connection handlers.
pub struct IpcContext {
    pub sessions: Mutex<SessionManager>,
}

// ─── Server ───

pub struct IpcServer {
    socket_path: PathBuf,
    listener: Option<UnixListener>,
    context: Arc<IpcContext>,
}

impl IpcServer {
    pub fn new(socket_path: PathBuf, context: Arc<IpcContext>) -> Self {
        Self {
            socket_path,
            listener: None,
            context,
        }
    }

    pub fn default_socket_path() -> PathBuf {
        let home = dirs::home_dir().expect("Cannot determine home directory");
        home.join(".alan").join("alan.sock")
    }

    pub async fn start(&mut self) -> Result<(), AlanError> {
        // Remove stale socket
        if self.socket_path.exists() {
            std::fs::remove_file(&self.socket_path)?;
        }

        // Ensure parent directory exists
        if let Some(parent) = self.socket_path.parent() {
            std::fs::create_dir_all(parent)?;
        }

        let listener = UnixListener::bind(&self.socket_path)?;
        info!(path = %self.socket_path.display(), "IPC server listening");
        self.listener = Some(listener);
        Ok(())
    }

    pub async fn accept_loop(&self) -> Result<(), AlanError> {
        let listener = self
            .listener
            .as_ref()
            .ok_or_else(|| AlanError::Protocol("Server not started".into()))?;

        loop {
            match listener.accept().await {
                Ok((stream, _addr)) => {
                    debug!("New client connection");
                    let ctx = Arc::clone(&self.context);
                    tokio::spawn(async move {
                        if let Err(e) = handle_connection(stream, ctx).await {
                            warn!(error = %e, "Client connection error");
                        }
                    });
                }
                Err(e) => {
                    error!(error = %e, "Accept error");
                }
            }
        }
    }

    pub async fn shutdown(&self) {
        if self.socket_path.exists() {
            let _ = std::fs::remove_file(&self.socket_path);
        }
        info!("IPC server shut down");
    }
}

// ─── Connection Handler ───

async fn handle_connection(stream: UnixStream, ctx: Arc<IpcContext>) -> Result<(), AlanError> {
    let (reader, mut writer) = stream.into_split();
    let mut reader = BufReader::new(reader);
    let mut line = String::new();

    loop {
        line.clear();
        let n = reader.read_line(&mut line).await?;
        if n == 0 {
            debug!("Client disconnected");
            break;
        }

        let request: JsonRpcRequest = match serde_json::from_str(line.trim()) {
            Ok(req) => req,
            Err(e) => {
                let resp = JsonRpcResponse::error(
                    None,
                    error_codes::PARSE_ERROR,
                    format!("Parse error: {e}"),
                );
                let mut resp_bytes = serde_json::to_vec(&resp)?;
                resp_bytes.push(b'\n');
                writer.write_all(&resp_bytes).await?;
                continue;
            }
        };

        let response = dispatch_request(&request, &ctx).await;
        let mut resp_bytes = serde_json::to_vec(&response)?;
        resp_bytes.push(b'\n');
        writer.write_all(&resp_bytes).await?;
    }

    Ok(())
}

// ─── Request Dispatch ───

async fn dispatch_request(request: &JsonRpcRequest, ctx: &IpcContext) -> JsonRpcResponse {
    let id = Some(request.id.clone());

    match request.method.as_str() {
        "ping" => JsonRpcResponse::success(
            id,
            serde_json::json!({
                "result": "pong",
                "version": env!("CARGO_PKG_VERSION")
            }),
        ),

        "session.create" => {
            let params = request.params.as_ref();
            let workspace = params
                .and_then(|p| p.get("workspace"))
                .and_then(|v| v.as_str())
                .unwrap_or(".");
            let model = params
                .and_then(|p| p.get("model"))
                .and_then(|v| v.as_str())
                .unwrap_or("claude-sonnet-4-20250514");

            let sessions = ctx.sessions.lock().await;
            match sessions.create_session(workspace, model) {
                Ok(info) => {
                    JsonRpcResponse::success(id, serde_json::to_value(info).unwrap_or_default())
                }
                Err(e) => JsonRpcResponse::error(id, e.to_rpc_code(), e.to_string()),
            }
        }

        "session.list" => {
            let sessions = ctx.sessions.lock().await;
            match sessions.list_sessions() {
                Ok(list) => {
                    JsonRpcResponse::success(id, serde_json::to_value(list).unwrap_or_default())
                }
                Err(e) => JsonRpcResponse::error(id, e.to_rpc_code(), e.to_string()),
            }
        }

        "session.events" => {
            let params = request.params.as_ref();
            let session_id = match extract_session_id(params) {
                Ok(uid) => uid,
                Err(resp) => return resp.with_id(id),
            };

            let from_seq = params
                .and_then(|p| p.get("from_seq"))
                .and_then(|v| v.as_u64())
                .unwrap_or(0);
            let limit = params
                .and_then(|p| p.get("limit"))
                .and_then(|v| v.as_u64());

            let sessions = ctx.sessions.lock().await;
            match sessions.get_events(&session_id, from_seq, limit) {
                Ok(events) => {
                    JsonRpcResponse::success(id, serde_json::to_value(events).unwrap_or_default())
                }
                Err(e) => JsonRpcResponse::error(id, e.to_rpc_code(), e.to_string()),
            }
        }

        "session.append_event" => {
            let params = request.params.as_ref();
            let session_id = match extract_session_id(params) {
                Ok(uid) => uid,
                Err(resp) => return resp.with_id(id),
            };

            let event = params
                .and_then(|p| p.get("event"))
                .and_then(|v| serde_json::from_value::<SessionEvent>(v.clone()).ok());

            let event = match event {
                Some(e) => e,
                None => {
                    return JsonRpcResponse::error(
                        id,
                        error_codes::INVALID_PARAMS,
                        "Missing or invalid event".to_string(),
                    );
                }
            };

            let sessions = ctx.sessions.lock().await;
            match sessions.append_event(&session_id, &event) {
                Ok(seq) => JsonRpcResponse::success(id, serde_json::json!({ "seq": seq })),
                Err(e) => JsonRpcResponse::error(id, e.to_rpc_code(), e.to_string()),
            }
        }

        _ => JsonRpcResponse::error(
            id,
            error_codes::METHOD_NOT_FOUND,
            format!("Method not found: {}", request.method),
        ),
    }
}

fn extract_session_id(
    params: Option<&serde_json::Value>,
) -> Result<uuid::Uuid, JsonRpcResponse> {
    let raw = params
        .and_then(|p| p.get("session_id"))
        .and_then(|v| v.as_str());

    match raw {
        Some(s) => s.parse::<uuid::Uuid>().map_err(|e| {
            JsonRpcResponse::error(
                None,
                error_codes::INVALID_PARAMS,
                format!("Invalid session_id: {e}"),
            )
        }),
        None => Err(JsonRpcResponse::error(
            None,
            error_codes::INVALID_PARAMS,
            "Missing session_id".to_string(),
        )),
    }
}

// ─── Client ───

pub struct IpcClient {
    reader: BufReader<tokio::net::unix::OwnedReadHalf>,
    writer: tokio::net::unix::OwnedWriteHalf,
}

impl IpcClient {
    pub async fn connect(path: &Path) -> Result<Self, AlanError> {
        let stream = UnixStream::connect(path).await?;
        let (reader, writer) = stream.into_split();
        Ok(Self {
            reader: BufReader::new(reader),
            writer,
        })
    }

    pub async fn call(&mut self, request: JsonRpcRequest) -> Result<JsonRpcResponse, AlanError> {
        let mut req_bytes = serde_json::to_vec(&request)?;
        req_bytes.push(b'\n');
        self.writer.write_all(&req_bytes).await?;

        let mut line = String::new();
        self.reader.read_line(&mut line).await?;

        let response: JsonRpcResponse = serde_json::from_str(line.trim())?;
        Ok(response)
    }
}
