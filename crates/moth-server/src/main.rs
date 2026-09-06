use std::net::SocketAddr;

use moth_server::{config::Config, db, router, state::AppState};
use tracing::info;

#[tokio::main]
async fn main() -> Result<(), moth_server::error::AppError> {
    let config = Config::from_env()?;
    config.init_tracing()?;

    let pool = db::connect(&config).await?;
    let bind_addr: SocketAddr = config.bind_addr;
    let state = AppState::new(config.clone(), pool);
    let app = router(state.clone());
    let listener = tokio::net::TcpListener::bind(bind_addr).await?;

    // Index the library in the background on startup; the scan task is
    // short-lived and never blocks the server.
    tokio::spawn(async move {
        if let Err(error) = moth_server::library::start_scan_on(&state).await {
            tracing::warn!(%error, "could not start initial library scan");
        }
    });

    info!(address = %bind_addr, "Moth server listening");
    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await
        .map_err(Into::into)
}

#[cfg(unix)]
async fn shutdown_signal() {
    use tokio::signal::unix::{SignalKind, signal};

    let ctrl_c = async {
        if let Err(error) = tokio::signal::ctrl_c().await {
            tracing::error!(%error, "failed to install Ctrl+C handler");
        }
    };

    let terminate = async {
        match signal(SignalKind::terminate()) {
            Ok(mut signal) => {
                signal.recv().await;
            }
            Err(error) => {
                tracing::error!(%error, "failed to install SIGTERM handler");
            }
        }
    };

    tokio::select! {
        _ = ctrl_c => {},
        _ = terminate => {},
    }
    tracing::info!("shutdown signal received");
}

#[cfg(not(unix))]
async fn shutdown_signal() {
    if let Err(error) = tokio::signal::ctrl_c().await {
        tracing::error!(%error, "failed to install Ctrl+C handler");
    }
    tracing::info!("shutdown signal received");
}
