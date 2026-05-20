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

    // Crash recovery: detect sessions that were active when we last shut down uncleanly
    match sessions.find_dirty_sessions() {
        Ok(dirty) if !dirty.is_empty() => {
            info!(
                count = dirty.len(),
                "Found dirty sessions from prior crash — appending recovery notes"
            );
            for s in &dirty {
                let _ = sessions.append_event(
                    &s.id,
                    &alan_core::protocol::SessionEvent::SystemNote {
                        content: "Session recovered after unclean shutdown. Some in-flight work may have been lost.".to_string(),
                    },
                );
                let _ = sessions.mark_ended(&s.id);
            }
        }
        Ok(_) => info!("No dirty sessions found — clean startup"),
        Err(e) => error!(error = %e, "Failed to check for dirty sessions"),
    }

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
