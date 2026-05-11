//! Shared application state passed to axum handlers.

use std::sync::{Arc, Mutex};

use controller::VirtualRenderer;
use sequencer::SharedShow;
use tokio::sync::broadcast;

use crate::{
    audio_store::AudioStore, layout_store::LayoutStore, spotify_routes::SpotifyServices,
    store::SequenceStore,
};

/// Capacity of the status broadcast channel. Receivers that fall behind will
/// see `RecvError::Lagged` and should discard the missed messages — the next
/// one carries the latest state so nothing is truly lost.
pub const STATUS_CHANNEL_CAPACITY: usize = 16;

#[derive(Clone)]
pub struct AppState {
    pub renderer: Arc<VirtualRenderer>,
    pub show: SharedShow,
    pub store: Arc<SequenceStore>,
    pub layouts: Arc<LayoutStore>,
    pub audio: Arc<AudioStore>,
    /// Id of the layout the simulator should use for prop placement.
    /// `None` means "flat horizontal strip" (legacy behavior).
    pub active_layout: Arc<Mutex<Option<String>>>,
    /// Spotify integration handles. `None` when `SPOTIFY_CLIENT_ID` is unset.
    pub spotify: Option<SpotifyServices>,
    /// Broadcast channel for pushing serialised `StatusResponse` JSON to all
    /// connected `/ws/status` clients whenever show state changes.
    pub status_tx: broadcast::Sender<Arc<String>>,
}
