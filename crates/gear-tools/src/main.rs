use clap::{Parser, Subcommand};
use std::io::{self, Read};
use std::path::PathBuf;

#[derive(Parser)]
#[command(name = "gear-tools", version, about = "Gear built-in tool executor")]
struct Cli {
    /// Workspace root directory
    #[arg(long, default_value = ".")]
    workspace: PathBuf,

    /// Run bash commands through the platform sandbox
    #[arg(long, default_value_t = false)]
    sandbox: bool,

    #[command(subcommand)]
    command: Commands,
}

#[derive(Subcommand)]
enum Commands {
    /// Read a file with line numbers
    ReadFile,
    /// List directory contents
    ListDir,
    /// Search file contents with regex
    Grep,
    /// Write a file atomically
    WriteFile,
    /// Edit a file with hash validation
    EditFile,
    /// Execute a bash command
    Bash,
    /// Search indexed symbols in the workspace
    SymbolSearch,
    /// Ranked BM25 full-text search over symbol-chunked code (FTS5)
    SearchCode,
    /// Build a compact structural repository map for automatic context
    RepoMap,
    /// Report which sandbox backend is available on this machine
    SandboxCheck,
}

fn read_stdin() -> String {
    let mut input = String::new();
    io::stdin().read_to_string(&mut input).unwrap_or_default();
    input
}

fn output_result<T: serde::Serialize>(result: Result<T, gear_tools::error::ToolError>) {
    match result {
        Ok(output) => {
            let json = serde_json::json!({
                "success": true,
                "result": output,
            });
            println!("{}", serde_json::to_string(&json).unwrap());
        }
        Err(e) => {
            let json = serde_json::json!({
                "success": false,
                "error": e.to_string(),
            });
            println!("{}", serde_json::to_string(&json).unwrap());
            std::process::exit(1);
        }
    }
}

#[tokio::main]
async fn main() {
    // Interrupt handling: the CLI cancels a tool call (Esc) by SIGTERM-ing
    // this process. The running command lives in its OWN process group (so
    // timeouts can kill whole trees), which also means our death alone would
    // ORPHAN it — the "interrupted" bash run kept running for up to its full
    // timeout, holding ports and files. Kill the registered child first, then
    // exit with the conventional interrupted status.
    #[cfg(unix)]
    tokio::spawn(async {
        use tokio::signal::unix::{SignalKind, signal};
        let term = signal(SignalKind::terminate());
        let int = signal(SignalKind::interrupt());
        if let (Ok(mut term), Ok(mut int)) = (term, int) {
            tokio::select! {
                _ = term.recv() => {},
                _ = int.recv() => {},
            }
            gear_sandbox::active_child::kill_active();
            std::process::exit(130);
        }
    });
    let cli = Cli::parse();
    // Canonical, but not VERBATIM. On Windows `canonicalize` returns
    // `\\?\C:\…`, which every path derived from the workspace would then carry
    // into the JSON these tools echo — and the harness above keys its
    // read-before-edit ledger on those strings. See src/paths.rs (P10.2).
    let workspace = gear_tools::paths::simplified(
        &std::fs::canonicalize(&cli.workspace).unwrap_or(cli.workspace.clone()),
    );
    let input_json = read_stdin();

    match cli.command {
        Commands::ReadFile => {
            let input: gear_tools::read_file::ReadFileInput = serde_json::from_str(&input_json)
                .unwrap_or_else(|e| {
                    eprintln!("Invalid input JSON: {e}");
                    std::process::exit(2);
                });
            output_result(gear_tools::read_file::execute(input, &workspace));
        }
        Commands::ListDir => {
            let input: gear_tools::list_dir::ListDirInput = serde_json::from_str(&input_json)
                .unwrap_or_else(|e| {
                    eprintln!("Invalid input JSON: {e}");
                    std::process::exit(2);
                });
            output_result(gear_tools::list_dir::execute(input, &workspace));
        }
        Commands::Grep => {
            let input: gear_tools::grep::GrepInput = serde_json::from_str(&input_json)
                .unwrap_or_else(|e| {
                    eprintln!("Invalid input JSON: {e}");
                    std::process::exit(2);
                });
            output_result(gear_tools::grep::execute(input, &workspace));
        }
        Commands::WriteFile => {
            let input: gear_tools::write_file::WriteFileInput = serde_json::from_str(&input_json)
                .unwrap_or_else(|e| {
                    eprintln!("Invalid input JSON: {e}");
                    std::process::exit(2);
                });
            output_result(gear_tools::write_file::execute(input, &workspace));
        }
        Commands::EditFile => {
            let input: gear_tools::edit_file::EditFileInput = serde_json::from_str(&input_json)
                .unwrap_or_else(|e| {
                    eprintln!("Invalid input JSON: {e}");
                    std::process::exit(2);
                });
            output_result(gear_tools::edit_file::execute(input, &workspace));
        }
        Commands::Bash => {
            let input: gear_tools::bash::BashInput = serde_json::from_str(&input_json)
                .unwrap_or_else(|e| {
                    eprintln!("Invalid input JSON: {e}");
                    std::process::exit(2);
                });
            if cli.sandbox {
                output_result(gear_tools::bash::execute_sandboxed(input, &workspace).await);
            } else {
                output_result(gear_tools::bash::execute(input, &workspace).await);
            }
        }
        Commands::SymbolSearch => {
            let input: gear_tools::symbol_search::SymbolSearchInput =
                serde_json::from_str(&input_json).unwrap_or_else(|e| {
                    eprintln!("Invalid input JSON: {e}");
                    std::process::exit(2);
                });
            output_result(gear_tools::symbol_search::execute(input, &workspace));
        }
        Commands::SearchCode => {
            let input: gear_tools::search_code::SearchCodeInput = serde_json::from_str(&input_json)
                .unwrap_or_else(|e| {
                    eprintln!("Invalid input JSON: {e}");
                    std::process::exit(2);
                });
            output_result(gear_tools::search_code::execute(input, &workspace));
        }
        Commands::RepoMap => {
            let input: gear_tools::repo_map::RepoMapInput = serde_json::from_str(&input_json)
                .unwrap_or_else(|e| {
                    eprintln!("Invalid input JSON: {e}");
                    std::process::exit(2);
                });
            output_result(gear_tools::repo_map::execute(input, &workspace));
        }
        Commands::SandboxCheck => {
            output_result::<gear_sandbox::SandboxProbe>(Ok(gear_sandbox::probe_capability()));
        }
    }
}
