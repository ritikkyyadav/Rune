use alan_core::config::EngineConfig;
use alan_core::ipc::{IpcContext, IpcServer};
use alan_core::session::SessionManager;
use alan_core::telemetry;
use std::sync::Arc;
use tokio::sync::Mutex;
use tracing::{error, info};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    telemetry::init_logging(true)?;
    info!("Alan daemon starting");

    let config = EngineConfig::default();
    config.ensure_dirs()?;

    let sessions = SessionManager::open(&config.db_path)?;
    let context = Arc::new(IpcContext {
        sessions: Mutex::new(sessions),
    });

    let mut server = IpcServer::new(config.socket_path.clone(), context);
    server.start().await?;

    let shutdown = tokio::signal::ctrl_c();

    tokio::select! {
        result = server.accept_loop() => {
            if let Err(e) = result {
                error!(error = %e, "Server error");
            }
        }
        _ = shutdown => {
            info!("Shutdown signal received");
            server.shutdown().await;
        }
    }

    Ok(())
}
