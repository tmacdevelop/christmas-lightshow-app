//! `lightshow-api` — Phase 2 axum server.
//!
//! Loads `config.toml`, starts the show engine producing frames at the
//! configured FPS, and exposes:
//!
//! - `GET  /healthz` — liveness probe.
//! - `GET  /ws`      — WebSocket stream of pixel frames (binary by default,
//!                     `?format=json` for debug).
//! - `*    /api/*`   — REST control plane (see [`rest`] module).

mod config;
mod rest;
mod state;
mod ws;

use std::sync::Arc;

use axum::{Router, routing::get};
use controller::{Rgb, VirtualRenderer};
use sequencer::{Engine, ShowState};
use tower_http::trace::TraceLayer;
use tracing_subscriber::EnvFilter;

use crate::{config::Config, state::AppState, ws::ws_handler};

const CONFIG_PATH_ENV: &str = "LIGHTSHOW_CONFIG";
const DEFAULT_CONFIG_PATH: &str = "config.toml";
const FRAME_CHANNEL_CAPACITY: usize = 8;

/// Default color the show starts with (warm Christmas red).
const DEFAULT_COLOR: Rgb = Rgb(255, 0, 0);

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")),
        )
        .init();

    let config_path = std::env::var(CONFIG_PATH_ENV).unwrap_or_else(|_| DEFAULT_CONFIG_PATH.into());
    let config = Config::load(&config_path)?;
    tracing::info!(?config, path = %config_path, "config loaded");

    // Renderer is shared with WS handlers (subscribers) and the engine
    // (publisher). VirtualRenderer's `publish` only needs `&self`, so we
    // wrap a single instance in an Arc and use it for both roles.
    let virtual_renderer = Arc::new(VirtualRenderer::new(
        config.pixel_count,
        FRAME_CHANNEL_CAPACITY,
    ));

    let show = ShowState::new(config.effect, DEFAULT_COLOR).shared();

    let state = AppState {
        renderer: Arc::clone(&virtual_renderer),
        show: Arc::clone(&show),
    };

    let engine_renderer = SharedRenderer(Arc::clone(&virtual_renderer));
    tracing::info!(effect = config.effect.name(), "starting engine");
    let engine = Engine::new(engine_renderer, Arc::clone(&show), config.fps);
    tokio::spawn(engine.run());

    let app = Router::new()
        .route("/healthz", get(healthz))
        .route("/ws", get(ws_handler))
        .nest("/api", rest::router())
        .with_state(state)
        .layer(TraceLayer::new_for_http());

    let listener = tokio::net::TcpListener::bind(config.bind).await?;
    let local = listener.local_addr()?;
    tracing::info!(%local, "lightshow-api listening");
    axum::serve(listener, app).await?;
    Ok(())
}

async fn healthz() -> &'static str {
    "ok"
}

/// Adapter that lets the engine drive the shared `Arc<VirtualRenderer>`.
///
/// `Renderer::render` takes `&mut self`, but broadcasting on a
/// `tokio::sync::broadcast::Sender` only needs `&self`. We forward through
/// `VirtualRenderer::publish` so the renderer can be safely shared.
struct SharedRenderer(Arc<VirtualRenderer>);

impl controller::Renderer for SharedRenderer {
    fn pixel_count(&self) -> usize {
        self.0.pixel_count()
    }

    fn render(&mut self, frame: &[controller::Rgb]) -> Result<(), controller::RenderError> {
        self.0.publish(frame)
    }
}
