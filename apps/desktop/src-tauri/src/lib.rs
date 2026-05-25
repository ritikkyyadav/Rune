use serde::{Deserialize, Serialize};
use std::sync::Mutex;

// ─── Types ───

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionInfo {
    pub id: String,
    pub title: String,
    pub model: String,
    pub workspace: String,
    pub event_count: u32,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Event {
    #[serde(rename = "type")]
    pub event_type: String,
    pub payload: serde_json::Value,
}

// ─── App State ───

struct AppState {
    sessions: Mutex<Vec<SessionInfo>>,
    next_id: Mutex<u32>,
}

impl Default for AppState {
    fn default() -> Self {
        Self {
            sessions: Mutex::new(Vec::new()),
            next_id: Mutex::new(1),
        }
    }
}

// ─── Tauri Commands ───

#[tauri::command]
fn create_session(state: tauri::State<'_, AppState>, workspace: String, model: String) -> String {
    let mut next_id = state.next_id.lock().unwrap();
    let id = format!("session-{:04}", *next_id);
    *next_id += 1;

    let now = chrono_now();
    let session = SessionInfo {
        id: id.clone(),
        title: "New Session".to_string(),
        model,
        workspace,
        event_count: 0,
        created_at: now.clone(),
        updated_at: now,
    };

    state.sessions.lock().unwrap().push(session);
    id
}

#[tauri::command]
fn list_sessions(state: tauri::State<'_, AppState>) -> Vec<SessionInfo> {
    state.sessions.lock().unwrap().clone()
}

#[tauri::command]
fn send_message(
    _state: tauri::State<'_, AppState>,
    _session_id: String,
    message: String,
) -> Vec<Event> {
    // Stub: returns a simple assistant response event.
    // The real implementation will delegate to the TS orchestrator
    // via the shell plugin or a sidecar process.
    vec![
        Event {
            event_type: "text_delta".to_string(),
            payload: serde_json::json!({
                "text": format!(
                    "Echo from Rust stub: received message with {} characters. \
                     The real engine runs in the TypeScript orchestrator layer.",
                    message.len()
                )
            }),
        },
        Event {
            event_type: "turn_complete".to_string(),
            payload: serde_json::json!({
                "stopReason": "end",
                "totalTurns": 1
            }),
        },
    ]
}

/// Returns an ISO-8601 timestamp string (without pulling in chrono).
fn chrono_now() -> String {
    // Simple stub; in production this would use chrono or std::time
    "2025-01-01T00:00:00Z".to_string()
}

// ─── App Entry ───

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
            create_session,
            list_sessions,
            send_message,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Alan desktop");
}
