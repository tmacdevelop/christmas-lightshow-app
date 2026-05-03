//! REST control endpoints.
//!
//! Live show control (Phase 2):
//!
//! - `GET  /api/effects`    — list available effect kinds + the active one.
//! - `GET  /api/status`     — current playing state, brightness, color, effect,
//!   plus a `playback` block describing live vs. sequence mode.
//! - `POST /api/start`      — resume playback.
//! - `POST /api/stop`       — pause playback (engine emits black frames).
//! - `POST /api/effect`     — `{"kind": "solid"|"fade"|"chase"|"rainbow"}`.
//! - `POST /api/color`      — `{"r":0..255,"g":0..255,"b":0..255}` or
//!   `{"hex":"#rrggbb"}`.
//! - `POST /api/brightness` — `{"value": 0.0..1.0}`.
//!
//! Sequence library + playback (Phase 3):
//!
//! - `GET    /api/sequences`         — list saved sequences.
//! - `GET    /api/sequences/:id`     — fetch a sequence by id.
//! - `PUT    /api/sequences/:id`     — create/replace a sequence (body is the
//!   sequence JSON; `:id` must match `body.id`).
//! - `DELETE /api/sequences/:id`     — remove a sequence.
//! - `POST   /api/sequences/:id/play` — start playing a sequence;
//!   body `{"loop": bool}` (default `false`).
//! - `POST   /api/playback/stop`     — stop sequence playback (returns to live).

use axum::{
    Json, Router,
    extract::{Path, State},
    http::StatusCode,
    routing::{get, post},
};
use controller::Rgb;
use sequencer::{EffectKind, PlaybackInfo, Sequence};
use serde::{Deserialize, Serialize};

use crate::state::AppState;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/effects", get(list_effects))
        .route("/status", get(get_status))
        .route("/start", post(start))
        .route("/stop", post(stop))
        .route("/effect", post(set_effect))
        .route("/color", post(set_color))
        .route("/brightness", post(set_brightness))
        .route("/sequences", get(list_sequences))
        .route(
            "/sequences/{id}",
            get(get_sequence).put(put_sequence).delete(delete_sequence),
        )
        .route("/sequences/{id}/play", post(play_sequence))
        .route("/playback/stop", post(stop_playback))
}

#[derive(Serialize)]
struct EffectsResponse {
    available: Vec<EffectInfo>,
    active: &'static str,
}

#[derive(Serialize)]
struct EffectInfo {
    kind: &'static str,
    uses_color: bool,
}

#[derive(Serialize)]
struct StatusResponse {
    playing: bool,
    brightness: f32,
    color: ColorPayload,
    effect: &'static str,
    playback: PlaybackInfo,
}

#[derive(Serialize)]
struct ColorPayload {
    r: u8,
    g: u8,
    b: u8,
    hex: String,
}

impl From<Rgb> for ColorPayload {
    fn from(c: Rgb) -> Self {
        Self {
            r: c.0,
            g: c.1,
            b: c.2,
            hex: format!("#{:02x}{:02x}{:02x}", c.0, c.1, c.2),
        }
    }
}

#[derive(Deserialize)]
struct EffectRequest {
    kind: EffectKind,
}

#[derive(Deserialize)]
#[serde(untagged)]
enum ColorRequest {
    Rgb { r: u8, g: u8, b: u8 },
    Hex { hex: String },
}

#[derive(Deserialize)]
struct BrightnessRequest {
    value: f32,
}

async fn list_effects(State(state): State<AppState>) -> Json<EffectsResponse> {
    let active = with_show(&state, |s| s.kind());
    Json(EffectsResponse {
        available: EffectKind::ALL
            .iter()
            .map(|k| EffectInfo {
                kind: k.name(),
                uses_color: k.uses_color(),
            })
            .collect(),
        active: active.name(),
    })
}

async fn get_status(State(state): State<AppState>) -> Json<StatusResponse> {
    let snap = with_show(&state, |s| {
        (
            s.playing(),
            s.brightness(),
            s.color(),
            s.kind(),
            s.playback_info(),
        )
    });
    let (playing, brightness, color, kind, playback) = snap;
    Json(StatusResponse {
        playing,
        brightness,
        color: color.into(),
        effect: kind.name(),
        playback,
    })
}

async fn start(State(state): State<AppState>) -> Json<StatusResponse> {
    with_show(&state, |s| s.set_playing(true));
    get_status(State(state)).await
}

async fn stop(State(state): State<AppState>) -> Json<StatusResponse> {
    with_show(&state, |s| s.set_playing(false));
    get_status(State(state)).await
}

async fn set_effect(
    State(state): State<AppState>,
    Json(body): Json<EffectRequest>,
) -> Json<StatusResponse> {
    with_show(&state, |s| s.set_kind(body.kind));
    get_status(State(state)).await
}

async fn set_color(
    State(state): State<AppState>,
    Json(body): Json<ColorRequest>,
) -> Result<Json<StatusResponse>, (StatusCode, String)> {
    let color = match body {
        ColorRequest::Rgb { r, g, b } => Rgb(r, g, b),
        ColorRequest::Hex { hex } => {
            parse_hex(&hex).ok_or((StatusCode::BAD_REQUEST, format!("invalid hex color: {hex}")))?
        }
    };
    with_show(&state, |s| s.set_color(color));
    Ok(get_status(State(state)).await)
}

async fn set_brightness(
    State(state): State<AppState>,
    Json(body): Json<BrightnessRequest>,
) -> Result<Json<StatusResponse>, (StatusCode, String)> {
    if !body.value.is_finite() {
        return Err((
            StatusCode::BAD_REQUEST,
            "brightness must be a finite number".into(),
        ));
    }
    with_show(&state, |s| s.set_brightness(body.value));
    Ok(get_status(State(state)).await)
}

fn with_show<R>(state: &AppState, f: impl FnOnce(&mut sequencer::ShowState) -> R) -> R {
    let mut guard = match state.show.lock() {
        Ok(g) => g,
        Err(poisoned) => poisoned.into_inner(),
    };
    f(&mut guard)
}

fn parse_hex(s: &str) -> Option<Rgb> {
    let s = s.trim().trim_start_matches('#');
    if s.len() != 6 {
        return None;
    }
    let r = u8::from_str_radix(&s[0..2], 16).ok()?;
    let g = u8::from_str_radix(&s[2..4], 16).ok()?;
    let b = u8::from_str_radix(&s[4..6], 16).ok()?;
    Some(Rgb(r, g, b))
}

// ---------- Phase 3: sequences ----------

#[derive(Deserialize, Default)]
#[serde(default)]
struct PlayRequest {
    #[serde(rename = "loop")]
    looping: bool,
}

async fn list_sequences(State(state): State<AppState>) -> Json<Vec<Sequence>> {
    Json(state.store.list())
}

async fn get_sequence(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<Sequence>, (StatusCode, String)> {
    state
        .store
        .get(&id)
        .map(Json)
        .ok_or((StatusCode::NOT_FOUND, format!("no sequence with id '{id}'")))
}

async fn put_sequence(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(seq): Json<Sequence>,
) -> Result<Json<Sequence>, (StatusCode, String)> {
    if seq.id != id {
        return Err((
            StatusCode::BAD_REQUEST,
            format!("path id '{id}' does not match body id '{}'", seq.id),
        ));
    }
    state
        .store
        .save(seq)
        .map(Json)
        .map_err(|e| (StatusCode::BAD_REQUEST, e.to_string()))
}

async fn delete_sequence(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<StatusCode, (StatusCode, String)> {
    match state.store.delete(&id) {
        Ok(_) => {
            // If the engine was playing this sequence, return to live mode so
            // we don't leave a dangling reference.
            with_show(&state, |s| {
                if s.playback_info().sequence_id.as_deref() == Some(&id) {
                    s.stop_sequence();
                }
            });
            Ok(StatusCode::NO_CONTENT)
        }
        Err(crate::store::StoreError::NotFound(_)) => {
            Err((StatusCode::NOT_FOUND, format!("no sequence with id '{id}'")))
        }
        Err(e) => Err((StatusCode::BAD_REQUEST, e.to_string())),
    }
}

async fn play_sequence(
    State(state): State<AppState>,
    Path(id): Path<String>,
    body: Option<Json<PlayRequest>>,
) -> Result<Json<StatusResponse>, (StatusCode, String)> {
    let seq = state
        .store
        .get(&id)
        .ok_or((StatusCode::NOT_FOUND, format!("no sequence with id '{id}'")))?;
    let looping = body.map(|Json(b)| b.looping).unwrap_or(false);
    with_show(&state, |s| s.play_sequence(seq, looping));
    Ok(get_status(State(state)).await)
}

async fn stop_playback(State(state): State<AppState>) -> Json<StatusResponse> {
    with_show(&state, |s| s.stop_sequence());
    get_status(State(state)).await
}
