use clap::{Parser, Subcommand};
use std::io::{self, Read};
use std::path::PathBuf;

#[derive(Parser)]
#[command(name = "alan-tools", version, about = "Alan built-in tool executor")]
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
}

fn read_stdin() -> String {
    let mut input = String::new();
    io::stdin().read_to_string(&mut input).unwrap_or_default();
    input
}

fn output_result<T: serde::Serialize>(result: Result<T, alan_tools::error::ToolError>) {
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
    let cli = Cli::parse();
    let workspace = std::fs::canonicalize(&cli.workspace).unwrap_or(cli.workspace.clone());
    let input_json = read_stdin();

    match cli.command {
        Commands::ReadFile => {
            let input: alan_tools::read_file::ReadFileInput =
                serde_json::from_str(&input_json).unwrap_or_else(|e| {
                    eprintln!("Invalid input JSON: {e}");
                    std::process::exit(2);
                });
            output_result(alan_tools::read_file::execute(input, &workspace));
        }
        Commands::ListDir => {
            let input: alan_tools::list_dir::ListDirInput =
                serde_json::from_str(&input_json).unwrap_or_else(|e| {
                    eprintln!("Invalid input JSON: {e}");
                    std::process::exit(2);
                });
            output_result(alan_tools::list_dir::execute(input, &workspace));
        }
        Commands::Grep => {
            let input: alan_tools::grep::GrepInput =
                serde_json::from_str(&input_json).unwrap_or_else(|e| {
                    eprintln!("Invalid input JSON: {e}");
                    std::process::exit(2);
                });
            output_result(alan_tools::grep::execute(input, &workspace));
        }
        Commands::WriteFile => {
            let input: alan_tools::write_file::WriteFileInput =
                serde_json::from_str(&input_json).unwrap_or_else(|e| {
                    eprintln!("Invalid input JSON: {e}");
                    std::process::exit(2);
                });
            output_result(alan_tools::write_file::execute(input, &workspace));
        }
        Commands::EditFile => {
            let input: alan_tools::edit_file::EditFileInput =
                serde_json::from_str(&input_json).unwrap_or_else(|e| {
                    eprintln!("Invalid input JSON: {e}");
                    std::process::exit(2);
                });
            output_result(alan_tools::edit_file::execute(input, &workspace));
        }
        Commands::Bash => {
            let input: alan_tools::bash::BashInput =
                serde_json::from_str(&input_json).unwrap_or_else(|e| {
                    eprintln!("Invalid input JSON: {e}");
                    std::process::exit(2);
                });
            if cli.sandbox {
                output_result(alan_tools::bash::execute_sandboxed(input, &workspace).await);
            } else {
                output_result(alan_tools::bash::execute(input, &workspace).await);
            }
        }
        Commands::SymbolSearch => {
            let input: alan_tools::symbol_search::SymbolSearchInput =
                serde_json::from_str(&input_json).unwrap_or_else(|e| {
                    eprintln!("Invalid input JSON: {e}");
                    std::process::exit(2);
                });
            output_result(alan_tools::symbol_search::execute(input, &workspace));
        }
    }
}
