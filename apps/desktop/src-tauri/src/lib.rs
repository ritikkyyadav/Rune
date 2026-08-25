// ──────────────────────────────────────────────────────────────────────────
//  Gear Desktop — Tauri ↔ Engine bridge
//
//  The desktop app runs the same local orchestrator engine as the CLI. On
//  startup we spawn the TypeScript "engine-host" sidecar (via bun) and pump its
//  stdin/stdout. The webview's existing `invoke()`/`listen()` calls are bridged
//  to the host over line-delimited JSON:
//
//    invoke("chat_start", {...})  →  {"id":N,"cmd":"chat_start","args":{...}}  →  host
//    host streams {"stream":"chat_event","payload":{...}}  →  emit("chat_event", …)  →  webview
//
//  Because it is the real local engine reading the user's existing configuration,
//  every model, BYOK key, web-search backend (Brave/Tavily), MCP server and
//  skill available on the CLI is available here too — no separate config.
// ──────────────────────────────────────────────────────────────────────────

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::path::Path;
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{channel, Sender};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, State};

type PendingMap = Arc<Mutex<HashMap<u64, Sender<Result<Value, String>>>>>;

/// Shared bridge state managed by Tauri.
struct Bridge {
    stdin: Mutex<Option<ChildStdin>>,
    pending: PendingMap,
    next_id: AtomicU64,
    /// Set when the engine host could not be started; surfaced to every call so
    /// the UI shows a clear error instead of hanging.
    start_error: Mutex<Option<String>>,
    // Kept alive for the lifetime of the app so the child is not reaped early.
    _child: Mutex<Option<Child>>,
}

impl Bridge {
    /// Send a request to the engine host and block until its matching response.
    /// Tauri runs commands on a worker pool, so blocking here is fine.
    fn call(&self, cmd: &str, args: Value) -> Result<Value, String> {
        if let Some(err) = self.start_error.lock().unwrap().clone() {
            return Err(err);
        }
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let (tx, rx) = channel::<Result<Value, String>>();
        self.pending.lock().unwrap().insert(id, tx);

        let line = json!({ "id": id, "cmd": cmd, "args": args }).to_string() + "\n";
        {
            let mut guard = self.stdin.lock().unwrap();
            let stdin = guard
                .as_mut()
                .ok_or_else(|| "engine not started".to_string())?;
            stdin
                .write_all(line.as_bytes())
                .map_err(|e| format!("engine write failed: {e}"))?;
            stdin
                .flush()
                .map_err(|e| format!("engine flush failed: {e}"))?;
        }

        // chat_start acks immediately and streams via events; every other command
        // responds quickly. The long ceiling is just a safety net against a wedged host.
        match rx.recv_timeout(Duration::from_secs(900)) {
            Ok(result) => result,
            Err(_) => {
                self.pending.lock().unwrap().remove(&id);
                Err("engine timed out".to_string())
            }
        }
    }
}

/// Resolve how to launch the engine host: the bun binary, the repo root, the
/// Rust tools binary, and the extra environment used by the local engine.
/// GEAR_* configuration wins; the pre-rename `~/.alan` pointer/key file is still
/// read so an upgrade never strands sessions, settings, or credentials.
fn resolve_host() -> Result<(String, String, String, Vec<(String, String)>), String> {
    let home = std::env::var("HOME").map_err(|_| "HOME is not set".to_string())?;

    let (engine_root, bun_hint, tools_hint) = if let Ok(root) = std::env::var("GEAR_ROOT") {
        (
            root,
            std::env::var("GEAR_BUN").ok(),
            std::env::var("GEAR_TOOLS_BIN").ok(),
        )
    } else {
        let gear_pointer = format!("{home}/.gear/desktop.json");
        let pointer = [gear_pointer.clone(), format!("{home}/.alan/desktop.json")]
        .into_iter()
        .find(|candidate| Path::new(candidate).exists())
        .unwrap_or(gear_pointer);
        let txt = std::fs::read_to_string(&pointer).map_err(|_| {
            format!(
                "Gear's local engine is not configured. Launch it once from the source checkout \
                 (no GEAR_ROOT value and no {pointer})."
            )
        })?;
        let v: Value = serde_json::from_str(&txt).map_err(|e| format!("bad {pointer}: {e}"))?;
        let root = v
            .get("gearRoot")
            .or_else(|| v.get("alanRoot"))
            .and_then(|x| x.as_str())
            .ok_or_else(|| format!("{pointer} is missing \"gearRoot\""))?
            .to_string();
        (
            root,
            v.get("bun").and_then(|x| x.as_str()).map(String::from),
            v.get("toolsBin").and_then(|x| x.as_str()).map(String::from),
        )
    };

    let exists = |p: &str| Path::new(p).exists();

    let bun = bun_hint
        .filter(|p| exists(p))
        .or_else(|| {
            let p = format!("{home}/.bun/bin/bun");
            exists(&p).then_some(p)
        })
        .or_else(|| {
            let p = "/opt/homebrew/bin/bun".to_string();
            exists(&p).then_some(p)
        })
        .unwrap_or_else(|| "bun".to_string());

    let tools = tools_hint
        .filter(|p| exists(p))
        .or_else(|| {
            let p = format!("{engine_root}/target/release/gear-tools");
            exists(&p).then_some(p)
        })
        .or_else(|| {
            let p = format!("{engine_root}/target/debug/gear-tools");
            exists(&p).then_some(p)
        })
        .unwrap_or_else(|| "gear-tools".to_string());

    // Prefer Gear's key file; the pre-rename ~/.alan/.env is read as a fallback.
    let mut env = Vec::new();
    let gear_env = format!("{home}/.gear/.env");
    let env_path = [gear_env.clone(), format!("{home}/.alan/.env")]
    .into_iter()
    .find(|candidate| Path::new(candidate).exists())
    .unwrap_or(gear_env);
    if let Ok(txt) = std::fs::read_to_string(env_path) {
        for raw in txt.lines() {
            let line = raw.trim();
            if line.is_empty() || line.starts_with('#') {
                continue;
            }
            if let Some(eq) = line.find('=') {
                let key = line[..eq].trim().to_string();
                let mut val = line[eq + 1..].trim().to_string();
                if val.len() >= 2
                    && ((val.starts_with('"') && val.ends_with('"'))
                        || (val.starts_with('\'') && val.ends_with('\'')))
                {
                    val = val[1..val.len() - 1].to_string();
                }
                if !key.is_empty() {
                    env.push((key, val));
                }
            }
        }
    }

    Ok((bun, engine_root, tools, env))
}

/// Spawn the engine host child with piped stdio.
fn spawn_host() -> Result<Child, String> {
    let (bun, engine_root, tools, env) = resolve_host()?;
    let script = format!("{engine_root}/packages/orchestrator/src/bin/engine-host.ts");
    if !Path::new(&script).exists() {
        return Err(format!("engine host not found at {script}"));
    }
    let home = std::env::var("HOME").unwrap_or_default();
    let workspace = std::env::var("GEAR_WORKSPACE").unwrap_or(home);

    let mut cmd = Command::new(&bun);
    cmd.arg("run")
        .arg(&script)
        .env("GEAR_ROOT", &engine_root)
        .env("GEAR_TOOLS_BIN", &tools)
        .env("GEAR_WORKSPACE", &workspace)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    for (k, v) in env {
        cmd.env(k, v);
    }
    cmd.spawn()
        .map_err(|e| format!("failed to start engine via {bun}: {e}"))
}

/// Read host stdout: forward `stream` frames to the webview as events, and
/// resolve `id` responses waiting in the pending map.
fn reader_loop(stdout: ChildStdout, handle: AppHandle, pending: PendingMap) {
    let reader = BufReader::new(stdout);
    for line in reader.lines() {
        let line = match line {
            Ok(l) => l,
            Err(_) => break,
        };
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let v: Value = match serde_json::from_str(trimmed) {
            Ok(v) => v,
            Err(_) => {
                eprintln!("[engine] {trimmed}");
                continue;
            }
        };

        if let Some(stream) = v.get("stream").and_then(|s| s.as_str()) {
            let payload = v.get("payload").cloned().unwrap_or(Value::Null);
            // Stream names map 1:1 to the webview event names the UI listens for:
            // "chat_event", "engine_status", "permission_request", "ready".
            let _ = handle.emit(stream, payload);
        } else if let Some(id) = v.get("id").and_then(|i| i.as_u64()) {
            if let Some(tx) = pending.lock().unwrap().remove(&id) {
                let res = if v.get("ok").and_then(|b| b.as_bool()).unwrap_or(false) {
                    Ok(v.get("result").cloned().unwrap_or(Value::Null))
                } else {
                    Err(v
                        .get("error")
                        .and_then(|e| e.as_str())
                        .unwrap_or("engine error")
                        .to_string())
                };
                let _ = tx.send(res);
            }
        }
    }
}

// ─── Tauri commands (bridged 1:1 to the engine host) ───

#[tauri::command]
fn get_status(bridge: State<'_, Bridge>, session_id: Option<String>) -> Result<Value, String> {
    bridge.call("get_status", json!({ "sessionId": session_id }))
}

#[tauri::command]
fn create_session(bridge: State<'_, Bridge>, model: Option<String>) -> Result<Value, String> {
    bridge.call("create_session", json!({ "model": model }))
}

#[tauri::command]
fn list_sessions(bridge: State<'_, Bridge>) -> Result<Value, String> {
    bridge.call("list_sessions", json!({}))
}

#[tauri::command]
fn resume_session(bridge: State<'_, Bridge>, session_id: String) -> Result<Value, String> {
    bridge.call("resume_session", json!({ "sessionId": session_id }))
}

#[tauri::command]
fn delete_session(bridge: State<'_, Bridge>, session_id: String) -> Result<Value, String> {
    bridge.call("delete_session", json!({ "sessionId": session_id }))
}

#[tauri::command]
fn chat_start(
    bridge: State<'_, Bridge>,
    session_id: String,
    message: String,
) -> Result<Value, String> {
    bridge.call(
        "chat_start",
        json!({ "sessionId": session_id, "message": message }),
    )
}

#[tauri::command]
fn abort_chat(bridge: State<'_, Bridge>) -> Result<Value, String> {
    bridge.call("abort_chat", json!({}))
}

#[tauri::command]
fn switch_model(
    bridge: State<'_, Bridge>,
    model: String,
    provider: Option<String>,
) -> Result<Value, String> {
    bridge.call(
        "switch_model",
        json!({ "model": model, "provider": provider }),
    )
}

#[tauri::command]
fn respond_permission(
    bridge: State<'_, Bridge>,
    request_id: String,
    decision: String,
) -> Result<Value, String> {
    bridge.call(
        "respond_permission",
        json!({ "requestId": request_id, "decision": decision }),
    )
}

#[tauri::command]
fn list_providers(bridge: State<'_, Bridge>) -> Result<Value, String> {
    bridge.call("list_providers", json!({}))
}

#[tauri::command]
fn save_settings(
    bridge: State<'_, Bridge>,
    provider: Option<String>,
    model: Option<String>,
    permission_level: Option<String>,
    api_keys: Option<Value>,
) -> Result<Value, String> {
    bridge.call(
        "save_settings",
        json!({
            "provider": provider,
            "model": model,
            "permissionLevel": permission_level,
            "apiKeys": api_keys.unwrap_or_else(|| json!({})),
        }),
    )
}

// ─── System Memory ("dreaming") ───

#[tauri::command]
fn get_system_memory(bridge: State<'_, Bridge>) -> Result<Value, String> {
    bridge.call("get_system_memory", json!({}))
}

#[tauri::command]
fn save_system_memory(bridge: State<'_, Bridge>, content: String) -> Result<Value, String> {
    bridge.call("save_system_memory", json!({ "content": content }))
}

#[tauri::command]
fn add_memory_note(bridge: State<'_, Bridge>, text: String) -> Result<Value, String> {
    bridge.call("add_memory_note", json!({ "text": text }))
}

#[tauri::command]
fn set_memory_schedule(bridge: State<'_, Bridge>, schedule: String) -> Result<Value, String> {
    bridge.call("set_memory_schedule", json!({ "schedule": schedule }))
}

#[tauri::command]
fn reflect_system_memory(
    bridge: State<'_, Bridge>,
    focus: Option<String>,
) -> Result<Value, String> {
    bridge.call("reflect_system_memory", json!({ "focus": focus }))
}

#[tauri::command]
fn clear_system_memory(bridge: State<'_, Bridge>) -> Result<Value, String> {
    bridge.call("clear_system_memory", json!({}))
}

// ─── App entry ───

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            let pending: PendingMap = Arc::new(Mutex::new(HashMap::new()));

            let bridge = match spawn_host() {
                Ok(mut child) => {
                    let stdin = child.stdin.take();
                    let stdout = child.stdout.take();
                    let stderr = child.stderr.take();

                    if let Some(stdout) = stdout {
                        let handle = app.handle().clone();
                        let pending_reader = pending.clone();
                        thread::spawn(move || reader_loop(stdout, handle, pending_reader));
                    }
                    if let Some(stderr) = stderr {
                        thread::spawn(move || {
                            for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                                eprintln!("[engine] {line}");
                            }
                        });
                    }

                    Bridge {
                        stdin: Mutex::new(stdin),
                        pending,
                        next_id: AtomicU64::new(1),
                        start_error: Mutex::new(None),
                        _child: Mutex::new(Some(child)),
                    }
                }
                Err(err) => {
                    eprintln!("[gear-desktop] engine failed to start: {err}");
                    Bridge {
                        stdin: Mutex::new(None),
                        pending,
                        next_id: AtomicU64::new(1),
                        start_error: Mutex::new(Some(err)),
                        _child: Mutex::new(None),
                    }
                }
            };

            app.manage(bridge);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_status,
            create_session,
            list_sessions,
            resume_session,
            delete_session,
            chat_start,
            abort_chat,
            switch_model,
            respond_permission,
            list_providers,
            save_settings,
            get_system_memory,
            save_system_memory,
            add_memory_note,
            set_memory_schedule,
            reflect_system_memory,
            clear_system_memory,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Gear desktop");
}
