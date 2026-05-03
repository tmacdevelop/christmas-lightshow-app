//! Shared application state passed to axum handlers.

use std::sync::Arc;

use controller::VirtualRenderer;

#[derive(Clone)]
pub struct AppState {
    pub renderer: Arc<VirtualRenderer>,
}
