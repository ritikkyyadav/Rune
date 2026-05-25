use alan_core::ipc::{IpcClient, IpcContext, IpcServer};
use alan_core::protocol::{JsonRpcRequest, RequestId};
use alan_core::session::SessionManager;
use alan_core::telemetry;
use clap::{Parser, Subcommand};
use std::path::PathBuf;
use std::sync::Arc;
use tokio::sync::Mutex;
use tracing::{error, info};

#[derive(Parser)]
#[command(
    name = "alan",
    version,
    about = "Alan \u{2014} Agentic Coding Assistant"
)]
struct Cli {
    /// Path to Unix socket
    #[arg(long, global = true)]
    socket: Option<PathBuf>,

    #[command(subcommand)]
    command: Commands,
}

#[derive(Subcommand)]
enum Commands {
    /// Start the daemon
    Daemon,
    /// Ping the daemon
    Ping,
    /// Start a chat session
    Chat {
        /// Workspace root (defaults to cwd)
        #[arg(short, long)]
        workspace: Option<PathBuf>,
        /// Model override
        #[arg(short, long)]
        model: Option<String>,
        /// LLM provider (anthropic, openai, openrouter)
        #[arg(short, long)]
        provider: Option<String>,
        /// Auto-approve all tool calls
        #[arg(long)]
        yolo: bool,
    },
    /// Resume an existing session
    Resume {
        /// Session ID (full or prefix)
        id: String,
    },
    /// List sessions
    List,
}

// ─── TS Orchestrator Bridge ───

fn find_project_root() -> Option<PathBuf> {
    // Walk up from the binary looking for the project marker
    if let Ok(exe) = std::env::current_exe() {
        let mut dir = exe.as_path();
        for _ in 0..5 {
            if let Some(parent) = dir.parent() {
                dir = parent;
                if dir.join("packages").join("orchestrator").exists() {
                    return Some(dir.to_path_buf());
                }
            }
        }
    }
    // Fallback to ALAN_ROOT env var
    std::env::var("ALAN_ROOT").ok().map(PathBuf::from)
}

fn find_bun() -> String {
    if let Some(home) = dirs::home_dir() {
        let home_bun = home.join(".bun").join("bin").join("bun");
        if home_bun.exists() {
            return home_bun.to_string_lossy().to_string();
        }
    }
    "bun".to_string()
}

/// Spawn the TypeScript CLI and replace this process.
fn spawn_ts_cli(args: &[&str]) -> anyhow::Result<()> {
    let project_root = find_project_root()
        .ok_or_else(|| anyhow::anyhow!("Cannot find Alan project root. Set ALAN_ROOT env var."))?;

    let cli_script = project_root
        .join("packages")
        .join("orchestrator")
        .join("src")
        .join("bin")
        .join("alan-cli.ts");

    if !cli_script.exists() {
        anyhow::bail!("CLI script not found: {}", cli_script.display());
    }

    // Load API keys from ~/.alan/.env
    let env_file = dirs::home_dir().map(|h| h.join(".alan").join(".env"));

    let bun = find_bun();
    let mut cmd = std::process::Command::new(&bun);
    cmd.arg("run").arg(&cli_script);
    cmd.args(args);

    if let Some(ref env_path) = env_file {
        if env_path.exists() {
            if let Ok(content) = std::fs::read_to_string(env_path) {
                for line in content.lines() {
                    let line = line.trim();
                    if line.is_empty() || line.starts_with('#') {
                        continue;
                    }
                    if let Some((key, value)) = line.split_once('=') {
                        cmd.env(key.trim(), value.trim().trim_matches('"'));
                    }
                }
            }
        }
    }

    let status = cmd
        .stdin(std::process::Stdio::inherit())
        .stdout(std::process::Stdio::inherit())
        .stderr(std::process::Stdio::inherit())
        .status()?;

    std::process::exit(status.code().unwrap_or(1));
}

// ─── Main ───

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let cli = Cli::parse();
    let socket_path = cli.socket.unwrap_or_else(IpcServer::default_socket_path);

    match cli.command {
        Commands::Daemon => {
            telemetry::init_logging(true)?;
            info!("Alan daemon starting");

            let config = alan_core::config::EngineConfig::default();
            config.ensure_dirs()?;

            let sessions = SessionManager::open(&config.db_path)?;
            let context = Arc::new(IpcContext {
                sessions: Mutex::new(sessions),
            });

            let mut server = IpcServer::new(config.socket_path, context);
            server.start().await?;

            let shutdown = tokio::signal::ctrl_c();
            tokio::select! {
                result = server.accept_loop() => {
                    if let Err(e) = result {
                        error!(error = %e, "Server error");
                    }
                }
                _ = shutdown => {
                    server.shutdown().await;
                }
            }
        }

        Commands::Ping => {
            let mut client = IpcClient::connect(&socket_path).await?;
            let request = JsonRpcRequest {
                jsonrpc: "2.0".to_string(),
                id: RequestId::Number(1),
                method: "ping".to_string(),
                params: None,
            };
            let response = client.call(request).await?;
            if let Some(result) = response.result {
                println!("{}", serde_json::to_string_pretty(&result)?);
            } else if let Some(err) = response.error {
                eprintln!("Error: {} (code {})", err.message, err.code);
                std::process::exit(1);
            }
        }

        Commands::Chat {
            workspace,
            model,
            provider,
            yolo,
        } => {
            let ws = workspace
                .unwrap_or_else(|| std::env::current_dir().unwrap())
                .to_string_lossy()
                .to_string();

            let mut args: Vec<String> = vec!["chat".into(), "--workspace".into(), ws];
            if let Some(m) = model {
                args.push("--model".into());
                args.push(m);
            }
            if let Some(p) = provider {
                args.push("--provider".into());
                args.push(p);
            }
            if yolo {
                args.push("--yolo".into());
            }

            let refs: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
            spawn_ts_cli(&refs)?;
        }

        Commands::Resume { id } => {
            spawn_ts_cli(&["chat", "--resume", &id])?;
        }

        Commands::List => {
            // Direct DB access for session listing (no daemon needed)
            let config = alan_core::config::EngineConfig::default();
            if !config.db_path.exists() {
                println!("No sessions found.");
                return Ok(());
            }
            let sessions = SessionManager::open(&config.db_path)?;
            let list = sessions.list_sessions()?;
            if list.is_empty() {
                println!("No sessions found.");
            } else {
                println!("\nSessions:\n");
                for s in &list {
                    let short_id = &s.id.to_string()[..8];
                    let title = s.title.as_deref().unwrap_or("");
                    println!(
                        "  \x1b[36m{short_id}\x1b[0m  {ws}  \x1b[2m{events} events  {model}{title_sep}{title}\x1b[0m",
                        ws = s.workspace_root,
                        events = s.event_count,
                        model = s.model,
                        title_sep = if title.is_empty() { "" } else { "  " },
                    );
                }
                println!();
            }
        }
    }

    Ok(())
}
