//! WebSocket handler that streams frames to clients.
//!
//! Clients connect to `GET /ws`. By default the server pushes binary frames
//! (`[r, g, b, r, g, b, ...]`). Adding `?format=json` switches to a JSON text
//! frame `{"frame": N, "pixels": [[r,g,b], ...]}` for debugging.

use std::sync::Arc;

use axum::{
    extract::{
        Query, State, WebSocketUpgrade,
        ws::{Message, WebSocket},
    },
    response::IntoResponse,
};
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use tokio::sync::broadcast::error::RecvError;

use crate::state::AppState;

#[derive(Debug, Default, Deserialize)]
pub struct WsParams {
    #[serde(default)]
    format: WireFormat,
}

#[derive(Debug, Default, Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum WireFormat {
    #[default]
    Binary,
    Json,
}

#[derive(Serialize)]
struct JsonFrame {
    frame: u64,
    pixels: Vec<[u8; 3]>,
}

pub async fn ws_handler(
    ws: WebSocketUpgrade,
    Query(params): Query<WsParams>,
    State(state): State<AppState>,
) -> impl IntoResponse {
    ws.on_upgrade(move |socket| handle_socket(socket, state, params.format))
}

async fn handle_socket(socket: WebSocket, state: AppState, format: WireFormat) {
    let (mut sender, mut receiver) = socket.split();
    let mut frames = state.renderer.subscribe();

    tracing::info!(?format, "ws client connected");

    // Spawn a task that drains incoming messages so the client can close cleanly.
    // Phase 1 ignores anything the client sends.
    let drain = tokio::spawn(async move {
        while let Some(msg) = receiver.next().await {
            match msg {
                Ok(Message::Close(_)) | Err(_) => break,
                _ => {}
            }
        }
    });

    let mut frame_no: u64 = 0;
    loop {
        let payload: Arc<Vec<u8>> = match frames.recv().await {
            Ok(p) => p,
            Err(RecvError::Lagged(skipped)) => {
                tracing::warn!(skipped, "client lagged behind frame stream");
                continue;
            }
            Err(RecvError::Closed) => break,
        };

        let send_result = match format {
            WireFormat::Binary => {
                sender
                    .send(Message::Binary(payload.as_ref().clone().into()))
                    .await
            }
            WireFormat::Json => {
                let pixels: Vec<[u8; 3]> = payload
                    .chunks_exact(3)
                    .map(|c| [c[0], c[1], c[2]])
                    .collect();
                let json = serde_json::to_string(&JsonFrame {
                    frame: frame_no,
                    pixels,
                })
                .expect("json serialize");
                sender.send(Message::Text(json.into())).await
            }
        };

        if send_result.is_err() {
            break;
        }
        frame_no = frame_no.wrapping_add(1);
    }

    drain.abort();
    tracing::info!("ws client disconnected");
}
