// ──────────────────────────────────────────────────────────────────────────
//  Gear Desktop — Tauri ↔ Engine bridge
//
//  The desktop app runs the same local orchestrator engine as the CLI. On
//  startup we spawn the TypeScript "engine-host" sidecar (via bun) and pump its
//  stdin/stdout. The webview drives it through ONE passthrough command and one
//  event pipe — see "The bridge, as ONE command" below for why there is no
//  per-command mirror any more:
//
//    invoke("engine_call", {cmd:"chat_start", args:{…}})
//                                 →  {"id":N,"cmd":"chat_start","args":{…}}  →  host
//    host streams {"stream":"chat_event","payload":{…}}  →  emit("chat_event", …)  →  webview
//
//  `~/.gear/desktop.json` says where the engine checkout is; `gear desktop`
//  writes it. Before that command existed, nothing in the repository did, and
//  the app could not start on a machine it had not been hand-configured on.
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
                "Gear's local engine is not configured: no GEAR_ROOT and no {pointer}. \
                 Run `gear desktop` once from the terminal — it writes that file and \
                 opens this app."
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
/// The packaged `gear` binary shipped beside this executable, if there is one.
///
/// This is what makes a `.dmg` a product rather than a developer preview: a
/// bundled app runs `gear engine-host`, so nobody needs Bun, a source checkout,
/// or a pointer file. `~/.gear/desktop.json` remains the path for a checkout,
/// and is checked SECOND — a developer running the app from source has a reason
/// to want their own tree, and a stale bundled binary silently winning over it
/// is the kind of thing that costs an afternoon.
fn bundled_sidecar() -> Option<String> {
    let exe = std::env::current_exe().ok()?;
    let dir = exe.parent()?;
    let name = if cfg!(windows) { "gear.exe" } else { "gear" };
    // macOS: Contents/MacOS/<exe> with the sidecar beside it, and
    // Contents/Resources for a resource-bundled copy. Linux/Windows: beside.
    let candidates = [
        dir.join(name),
        dir.join("../Resources").join(name),
        dir.join("resources").join(name),
    ];
    candidates
        .iter()
        .find(|p| p.exists())
        .map(|p| p.to_string_lossy().into_owned())
}

fn spawn_host() -> Result<Child, String> {
    let home = std::env::var("HOME").unwrap_or_default();
    let workspace = std::env::var("GEAR_WORKSPACE").unwrap_or(home);

    // ── The packaged path ──
    if let Some(sidecar) = bundled_sidecar() {
        let mut cmd = Command::new(&sidecar);
        cmd.arg("engine-host")
            .env("GEAR_WORKSPACE", &workspace)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        // gear-tools ships beside the launcher; the CLI finds it on its own,
        // but naming it here removes one lookup from the startup path.
        if let Ok(home) = std::env::var("HOME") {
            let tools = format!("{home}/.gear/bin/gear-tools");
            if Path::new(&tools).exists() {
                cmd.env("GEAR_TOOLS_BIN", tools);
            }
        }
        return cmd
            .spawn()
            .map_err(|e| format!("failed to start the bundled engine ({sidecar}): {e}"));
    }

    // ── The source-checkout path ──
    let (bun, engine_root, tools, env) = resolve_host()?;
    let script = format!("{engine_root}/packages/orchestrator/src/bin/engine-host.ts");
    if !Path::new(&script).exists() {
        return Err(format!("engine host not found at {script}"));
    }

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

// ─── The bridge, as ONE command ───
//
// This file used to hand-type a Tauri command per host command: seventeen of
// them, each a three-line mirror of a name the host already knows. That pattern
// drifted twice in the two ways it always drifts. `interject_chat` was added to
// the host and called by the UI and never added here, so mid-turn steering threw
// and the webview reported it as a lost connection. `save_settings` grew a
// `persist` field this signature did not have, so serde dropped it and gear
// persistence was a permanent silent no-op.
//
// Neither was visible to CI, because nothing type-checked across the seam. The
// fix is to stop having a seam: `engine_call(cmd, args)` forwards whatever the
// webview asks for, and the checking happens where the types actually live — in
// `@gear/protocol`, on both sides of the wire. Adding a host command now costs
// zero Rust.
//
// The six `*_system_memory` commands that used to live here were never called
// by any webview code. They are gone; the host still serves them, and
// `engine_call` reaches them the moment a surface wants one.

#[tauri::command]
fn engine_call(
    bridge: State<'_, Bridge>,
    cmd: String,
    args: Option<Value>,
) -> Result<Value, String> {
    bridge.call(&cmd, args.unwrap_or_else(|| json!({})))
}

/// Whether the sidecar started, and why not when it did not.
///
/// The UI needs this to tell "no engine configured on this machine" apart from
/// "the engine dropped": the first has a fix the user can act on
/// (`gear desktop`, which writes the pointer), and before this it was
/// indistinguishable from a lost connection.
#[tauri::command]
fn engine_health(bridge: State<'_, Bridge>) -> Result<Value, String> {
    let err = bridge.start_error.lock().unwrap().clone();
    let pointer = std::env::var("HOME")
        .map(|h| format!("{h}/.gear/desktop.json"))
        .unwrap_or_default();
    Ok(json!({ "started": err.is_none(), "error": err, "pointer": pointer }))
}

// ─── App entry ───

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        // The updater is registered unconditionally and CONFIGURED by
        // tauri.conf.json. With no public key set it simply has nothing it will
        // accept, which is the right posture for an unsigned build: an updater
        // that installs whatever a URL hands it is worse than no updater.
        .plugin(tauri_plugin_updater::Builder::new().build())
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
        .invoke_handler(tauri::generate_handler![engine_call, engine_health])
        .run(tauri::generate_context!())
        .expect("error while running Gear desktop");
}
