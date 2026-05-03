//! `lightshow-api` — Phase 1 axum server.
//!
//! Loads `config.toml`, starts the show engine producing rainbow frames at the
//! configured FPS, and exposes:
//!
//! - `GET /healthz` — liveness probe.
//! - `GET /ws` — WebSocket stream of pixel frames (binary by default,
//!   `?format=json` for debug).

mod config;
mod state;
mod ws;

use std::sync::Arc;

use axum::{Router, routing::get};
use controller::VirtualRenderer;
use sequencer::{
    Effect, Engine,
    effects::{Chase, Fade, Rainbow, Solid},
};
use tower_http::trace::TraceLayer;
use tracing_subscriber::EnvFilter;

use crate::{
    config::{Config, EffectChoice},
    state::AppState,
    ws::ws_handler,
};

const CONFIG_PATH_ENV: &str = "LIGHTSHOW_CONFIG";
const DEFAULT_CONFIG_PATH: &str = "config.toml";
const FRAME_CHANNEL_CAPACITY: usize = 8;

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

    // Renderer is shared with WS handlers (subscribers) and owned by the engine
    // (publisher). We construct one and split: a clone-of-Arc for handlers,
    // and an owned VirtualRenderer for the engine. The trick is that publishing
    // is done through `tokio::sync::broadcast::Sender::send`, which only needs
    // `&self`, so we keep a single instance behind an Arc and use it for both.
    let virtual_renderer = Arc::new(VirtualRenderer::new(
        config.pixel_count,
        FRAME_CHANNEL_CAPACITY,
    ));

    let state = AppState {
        renderer: Arc::clone(&virtual_renderer),
    };

    // The Engine takes ownership of a Renderer. We give it an EngineRenderer
    // wrapper that delegates to the shared Arc<VirtualRenderer>.
    let engine_renderer = SharedRenderer(Arc::clone(&virtual_renderer));
    let effect = build_effect(config.effect);
    tracing::info!(effect = effect.name(), "starting engine");
    let engine = Engine::new(engine_renderer, effect, config.fps);
    tokio::spawn(engine.run());

    let app = Router::new()
        .route("/healthz", get(healthz))
        .route("/ws", get(ws_handler))
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

fn build_effect(choice: EffectChoice) -> Box<dyn Effect> {
    match choice {
        EffectChoice::Solid => Box::new(Solid::default()),
        EffectChoice::Fade => Box::new(Fade::default()),
        EffectChoice::Chase => Box::new(Chase::default()),
        EffectChoice::Rainbow => Box::new(Rainbow::default()),
    }
}

/// Adapter that lets the engine drive the shared `Arc<VirtualRenderer>`.
///
/// `VirtualRenderer::render` requires `&mut self` per the `Renderer` trait,
/// but the broadcast publish is internally `&self`-callable. We re-borrow and
/// forward via `Arc::get_mut` is unsafe here; instead we duplicate the
/// minimal logic by subscribing/publishing through the shared instance.
struct SharedRenderer(Arc<VirtualRenderer>);

impl controller::Renderer for SharedRenderer {
    fn pixel_count(&self) -> usize {
        self.0.pixel_count()
    }

    fn render(&mut self, frame: &[controller::Rgb]) -> Result<(), controller::RenderError> {
        // Safe because broadcasting only needs &self semantics; we expose a
        // wrapper method on VirtualRenderer.
        self.0.publish(frame)
    }
}
