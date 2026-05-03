//! Shared application state passed to axum handlers.

use std::sync::{Arc, Mutex};

use controller::VirtualRenderer;
use sequencer::SharedShow;

use crate::{layout_store::LayoutStore, store::SequenceStore};

#[derive(Clone)]
pub struct AppState {
    pub renderer: Arc<VirtualRenderer>,
    pub show: SharedShow,
    pub store: Arc<SequenceStore>,
    pub layouts: Arc<LayoutStore>,
    /// Id of the layout the simulator should use for prop placement.
    /// `None` means "flat horizontal strip" (legacy behavior).
    pub active_layout: Arc<Mutex<Option<String>>>,
}
