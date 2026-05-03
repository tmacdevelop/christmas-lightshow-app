//! REST control endpoints (Phase 2).
//!
//! All routes are mounted under `/api`:
//!
//! - `GET  /api/effects`    — list available effect kinds + the active one.
//! - `GET  /api/status`     — current playing state, brightness, color, effect.
//! - `POST /api/start`      — resume playback.
//! - `POST /api/stop`       — pause playback (engine emits black frames).
//! - `POST /api/effect`     — `{"kind": "solid"|"fade"|"chase"|"rainbow"}`.
//! - `POST /api/color`      — `{"r":0..255,"g":0..255,"b":0..255}`
//!                            or `{"hex":"#rrggbb"}`.
//! - `POST /api/brightness` — `{"value": 0.0..1.0}`.

use axum::{
    Json, Router,
    extract::State,
    http::StatusCode,
    routing::{get, post},
};
use controller::Rgb;
use sequencer::EffectKind;
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
        (s.playing(), s.brightness(), s.color(), s.kind())
    });
    let (playing, brightness, color, kind) = snap;
    Json(StatusResponse {
        playing,
        brightness,
        color: color.into(),
        effect: kind.name(),
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
        ColorRequest::Hex { hex } => parse_hex(&hex)
            .ok_or((StatusCode::BAD_REQUEST, format!("invalid hex color: {hex}")))?,
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
