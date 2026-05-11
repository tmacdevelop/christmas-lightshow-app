//! `lightshow-api` — Phase 2 axum server.
//!
//! Loads `config.toml`, starts the show engine producing frames at the
//! configured FPS, and exposes:
//!
//! - `GET  /healthz` — liveness probe.
//! - `GET  /ws` — WebSocket stream of pixel frames (binary by default,
//!   `?format=json` for debug).
//! - `GET  /ws/status` — WebSocket that pushes JSON status on every change.
//! - `*    /api/*` — REST control plane (see [`rest`] module).

mod audio_store;
mod config;
mod layout_store;
mod rest;
mod spotify_routes;
mod state;
mod store;
mod ws;

use std::sync::{Arc, Mutex};

use axum::{Router, routing::get};
use controller::{Rgb, VirtualRenderer};
use sequencer::{Engine, ShowState};
use tokio::sync::broadcast;
use tower_http::trace::TraceLayer;
use tracing_subscriber::EnvFilter;

use crate::{
    audio_store::AudioStore,
    config::Config,
    layout_store::LayoutStore,
    spotify_routes::SpotifyServices,
    state::{AppState, STATUS_CHANNEL_CAPACITY},
    store::SequenceStore,
    ws::{status_ws_handler, ws_handler},
};

const CONFIG_PATH_ENV: &str = "LIGHTSHOW_CONFIG";
const DEFAULT_CONFIG_PATH: &str = "config.toml";
const FRAME_CHANNEL_CAPACITY: usize = 8;

/// How often the playhead ticker fires while a sequence is playing (ms).
const STATUS_TICK_MS: u64 = 100;

/// Default color the show starts with (warm Christmas red).
const DEFAULT_COLOR: Rgb = Rgb(255, 0, 0);

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    // Best-effort load of `.env` for local dev (SPOTIFY_CLIENT_ID etc.).
    let _ = dotenvy::dotenv();

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

    let store = Arc::new(SequenceStore::open(&config.shows_dir)?);
    tracing::info!(path = %config.shows_dir.display(), count = store.list().len(), "sequence store opened");

    let layouts = Arc::new(LayoutStore::open(&config.layouts_dir)?);
    tracing::info!(path = %config.layouts_dir.display(), count = layouts.list().len(), "layout store opened");

    let audio = Arc::new(AudioStore::open(&config.audio_dir)?);
    tracing::info!(path = %config.audio_dir.display(), count = audio.list().len(), "audio store opened");

    let spotify = SpotifyServices::from_env(
        std::env::var("SPOTIFY_CLIENT_ID").ok(),
        std::env::var("SPOTIFY_REDIRECT_URI")
            .unwrap_or_else(|_| config.spotify.redirect_uri.clone()),
        config.spotify.token_path.clone(),
        config.spotify.cache_dir.clone(),
        std::env::var("SPOTIFY_UI_ORIGIN")
            .ok()
            .or_else(|| config.spotify.ui_origin.clone()),
    )?;
    if spotify.is_some() {
        tracing::info!(
            redirect_uri = %config.spotify.redirect_uri,
            cache = %config.spotify.cache_dir.display(),
            "spotify integration enabled"
        );
    }

    let (status_tx, _) = broadcast::channel::<Arc<String>>(STATUS_CHANNEL_CAPACITY);

    let state = AppState {
        renderer: Arc::clone(&virtual_renderer),
        show: Arc::clone(&show),
        store: Arc::clone(&store),
        layouts: Arc::clone(&layouts),
        audio: Arc::clone(&audio),
        active_layout: Arc::new(Mutex::new(None)),
        spotify,
        status_tx: status_tx.clone(),
    };

    let engine_renderer = SharedRenderer(Arc::clone(&virtual_renderer));
    tracing::info!(effect = config.effect.name(), "starting engine");
    let engine = Engine::new(engine_renderer, Arc::clone(&show), config.fps);
    tokio::spawn(engine.run());

    // Ticker: broadcast status at STATUS_TICK_MS intervals while a sequence
    // is actively playing so the UI playhead stays smooth without polling.
    let ticker_state = state.clone();
    tokio::spawn(async move {
        let interval = std::time::Duration::from_millis(STATUS_TICK_MS);
        loop {
            tokio::time::sleep(interval).await;
            // Only broadcast while there are connected clients and a sequence
            // is playing — avoids useless work when idle.
            if ticker_state.status_tx.receiver_count() == 0 {
                continue;
            }
            let is_sequence_playing = {
                let guard = match ticker_state.show.lock() {
                    Ok(g) => g,
                    Err(p) => p.into_inner(),
                };
                guard.playing() && guard.mode() == sequencer::PlaybackMode::Sequence
            };
            if is_sequence_playing {
                let json = rest::build_status_json(&ticker_state);
                let _ = ticker_state.status_tx.send(Arc::new(json));
            }
        }
    });

    let app = Router::new()
        .route("/healthz", get(healthz))
        .route("/ws", get(ws_handler))
        .route("/ws/status", get(status_ws_handler))
        .nest("/api", rest::router())
        .nest("/api/spotify", spotify_routes::router())
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
