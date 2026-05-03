//! Shared application state passed to axum handlers.

use std::sync::Arc;

use controller::VirtualRenderer;
use sequencer::SharedShow;

use crate::store::SequenceStore;

#[derive(Clone)]
pub struct AppState {
    pub renderer: Arc<VirtualRenderer>,
    pub show: SharedShow,
    pub store: Arc<SequenceStore>,
}
