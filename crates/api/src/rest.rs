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
//!
//! Layout designer (Phase 3):
//!
//! - `GET    /api/layouts`              — list saved layouts.
//! - `GET    /api/layouts/:id`          — fetch a layout by id.
//! - `PUT    /api/layouts/:id`          — create/replace a layout.
//! - `DELETE /api/layouts/:id`          — remove a layout.
//! - `POST   /api/layouts/:id/activate` — mark a layout as the one the
//!   simulator should render against.
//! - `POST   /api/layouts/deactivate`   — clear the active layout.
//!
//! Music synchronisation (Phase 4):
//!
//! - `POST   /api/audio/upload`         — upload an audio file (multipart).
//! - `GET    /api/audio`                — list uploaded audio tracks.
//! - `GET    /api/audio/:id`            — fetch track metadata + analysis.
//! - `GET    /api/audio/:id/file`       — serve raw audio bytes for browser playback.
//! - `POST   /api/audio/:id/generate`   — auto-generate a beat-synced sequence.
//! - `POST   /api/audio/:id/play`       — play the auto-generated sequence.
//! - `DELETE /api/audio/:id`            — delete a track.

use axum::{
    Json, Router,
    body::Body,
    extract::{Multipart, Path, State},
    http::{HeaderMap, HeaderValue, StatusCode, header},
    routing::{get, post},
};
use controller::Rgb;
use sequencer::{Clip, ClipColor, EffectKind, Layout, PlaybackInfo, Sequence};
use serde::{Deserialize, Serialize};

use crate::{audio_store::AudioTrack, state::AppState};

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
        .route("/layouts", get(list_layouts))
        .route(
            "/layouts/{id}",
            get(get_layout).put(put_layout).delete(delete_layout),
        )
        .route("/layouts/{id}/activate", post(activate_layout))
        .route("/layouts/deactivate", post(deactivate_layout))
        // Phase 4: music sync
        .route("/audio/upload", post(upload_audio))
        .route("/audio", get(list_audio))
        .route("/audio/{id}", get(get_audio).delete(delete_audio))
        .route("/audio/{id}/file", get(serve_audio_file))
        .route("/audio/{id}/generate", post(generate_sequence))
        .route("/audio/{id}/play", post(play_audio_sequence))
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
    active_layout_id: Option<String>,
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
        active_layout_id: active_layout_id(&state),
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

// ---------- Phase 3: layouts ----------

fn active_layout_id(state: &AppState) -> Option<String> {
    match state.active_layout.lock() {
        Ok(g) => g.clone(),
        Err(p) => p.into_inner().clone(),
    }
}

fn set_active_layout_id(state: &AppState, id: Option<String>) {
    let mut g = match state.active_layout.lock() {
        Ok(g) => g,
        Err(p) => p.into_inner(),
    };
    *g = id;
}

async fn list_layouts(State(state): State<AppState>) -> Json<Vec<Layout>> {
    Json(state.layouts.list())
}

async fn get_layout(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<Layout>, (StatusCode, String)> {
    state
        .layouts
        .get(&id)
        .map(Json)
        .ok_or((StatusCode::NOT_FOUND, format!("no layout with id '{id}'")))
}

async fn put_layout(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(layout): Json<Layout>,
) -> Result<Json<Layout>, (StatusCode, String)> {
    if layout.id != id {
        return Err((
            StatusCode::BAD_REQUEST,
            format!("path id '{id}' does not match body id '{}'", layout.id),
        ));
    }
    state
        .layouts
        .save(layout)
        .map(Json)
        .map_err(|e| (StatusCode::BAD_REQUEST, e.to_string()))
}

async fn delete_layout(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<StatusCode, (StatusCode, String)> {
    match state.layouts.delete(&id) {
        Ok(_) => {
            // Clear the active selection if it was pointing at this layout.
            if active_layout_id(&state).as_deref() == Some(&id) {
                set_active_layout_id(&state, None);
            }
            Ok(StatusCode::NO_CONTENT)
        }
        Err(crate::layout_store::LayoutStoreError::NotFound(_)) => {
            Err((StatusCode::NOT_FOUND, format!("no layout with id '{id}'")))
        }
        Err(e) => Err((StatusCode::BAD_REQUEST, e.to_string())),
    }
}

async fn activate_layout(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<StatusResponse>, (StatusCode, String)> {
    if state.layouts.get(&id).is_none() {
        return Err((StatusCode::NOT_FOUND, format!("no layout with id '{id}'")));
    }
    set_active_layout_id(&state, Some(id));
    Ok(get_status(State(state)).await)
}

async fn deactivate_layout(State(state): State<AppState>) -> Json<StatusResponse> {
    set_active_layout_id(&state, None);
    get_status(State(state)).await
}

// ---------- Phase 4: music sync ----------

fn unique_id() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .subsec_nanos();
    format!("{:08x}", ts ^ (std::process::id() << 16))
}

/// `POST /api/audio/upload` — multipart upload of an audio file.
async fn upload_audio(
    State(state): State<AppState>,
    mut multipart: Multipart,
) -> Result<Json<AudioTrack>, (StatusCode, String)> {
    let mut file_bytes: Option<Vec<u8>> = None;
    let mut filename = String::from("track");

    while let Some(field) = multipart
        .next_field()
        .await
        .map_err(|e| (StatusCode::BAD_REQUEST, format!("multipart error: {e}")))?
    {
        if field.name() == Some("file") {
            if let Some(name) = field.file_name() {
                filename = name.to_string();
            }
            let bytes = field
                .bytes()
                .await
                .map_err(|e| (StatusCode::BAD_REQUEST, format!("read error: {e}")))?;
            file_bytes = Some(bytes.to_vec());
            break;
        }
    }

    let bytes = file_bytes.ok_or((StatusCode::BAD_REQUEST, "missing 'file' field".into()))?;

    let analysis = audio::analyse(&bytes).map_err(|e| {
        (
            StatusCode::UNPROCESSABLE_ENTITY,
            format!("audio analysis failed: {e}"),
        )
    })?;

    let id = unique_id();
    let track = state
        .audio
        .save(&id, &filename, &bytes, analysis)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    Ok(Json(track))
}

/// `GET /api/audio` — list all uploaded tracks.
async fn list_audio(State(state): State<AppState>) -> Json<Vec<AudioTrack>> {
    Json(state.audio.list())
}

/// `GET /api/audio/:id` — fetch one track's metadata + analysis.
async fn get_audio(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<AudioTrack>, (StatusCode, String)> {
    state.audio.get(&id).map(Json).ok_or((
        StatusCode::NOT_FOUND,
        format!("no audio track with id '{id}'"),
    ))
}

/// `DELETE /api/audio/:id`
async fn delete_audio(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<StatusCode, (StatusCode, String)> {
    state
        .audio
        .delete(&id)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))
        .map(|_| StatusCode::NO_CONTENT)
}

/// `GET /api/audio/:id/file` — stream raw audio bytes to the browser.
async fn serve_audio_file(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<(HeaderMap, Body), (StatusCode, String)> {
    let track = state.audio.get(&id).ok_or((
        StatusCode::NOT_FOUND,
        format!("no audio track with id '{id}'"),
    ))?;

    let path = state.audio.audio_path(&id);
    let bytes = tokio::fs::read(&path)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    // Guess MIME type from extension.
    let content_type = match track
        .filename
        .rsplit('.')
        .next()
        .unwrap_or("")
        .to_lowercase()
        .as_str()
    {
        "mp3" => "audio/mpeg",
        "ogg" => "audio/ogg",
        "flac" => "audio/flac",
        "aac" | "m4a" => "audio/aac",
        _ => "audio/wav",
    };

    let mut headers = HeaderMap::new();
    headers.insert(header::CONTENT_TYPE, HeaderValue::from_static(content_type));
    headers.insert(
        header::CONTENT_DISPOSITION,
        HeaderValue::from_str(&format!("inline; filename=\"{}\"", track.filename))
            .unwrap_or(HeaderValue::from_static("inline")),
    );

    Ok((headers, Body::from(bytes)))
}

/// Beat-flash colours: cycle through these on consecutive beats.
const BEAT_COLORS: &[(u8, u8, u8)] = &[
    (255, 0, 0),     // red
    (0, 255, 0),     // green
    (255, 255, 0),   // yellow
    (0, 0, 255),     // blue
    (255, 128, 0),   // orange
    (255, 0, 255),   // magenta
    (0, 255, 255),   // cyan
    (255, 255, 255), // white
];

/// `POST /api/audio/:id/generate` — build and save a beat-synced sequence.
///
/// Creates one clip per beat that lasts until the next beat (or 500 ms for the
/// last beat). Effects cycle through the `BEAT_COLORS` palette.
async fn generate_sequence(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<Sequence>, (StatusCode, String)> {
    let track = state.audio.get(&id).ok_or((
        StatusCode::NOT_FOUND,
        format!("no audio track with id '{id}'"),
    ))?;

    let beats = &track.analysis.beats_ms;
    if beats.is_empty() {
        return Err((
            StatusCode::UNPROCESSABLE_ENTITY,
            "no beats detected — cannot generate a sequence".into(),
        ));
    }

    let duration_ms = track.analysis.duration_ms;
    let mut clips: Vec<Clip> = Vec::with_capacity(beats.len());

    // Cycle: odd beats get Chase, even beats get Solid flash.
    let effect_kinds = [
        EffectKind::Chase,
        EffectKind::Solid,
        EffectKind::Fade,
        EffectKind::Rainbow,
    ];

    for (i, &beat_ms) in beats.iter().enumerate() {
        let next_ms = beats
            .get(i + 1)
            .copied()
            .unwrap_or_else(|| (beat_ms + 500).min(duration_ms as u32));
        let clip_duration_ms = (next_ms.saturating_sub(beat_ms)).max(50) as u64;
        let color = BEAT_COLORS[i % BEAT_COLORS.len()];
        let kind = effect_kinds[i % effect_kinds.len()];

        clips.push(Clip {
            id: format!("beat-{i}"),
            start_ms: beat_ms as u64,
            duration_ms: clip_duration_ms,
            kind,
            color: ClipColor {
                r: color.0,
                g: color.1,
                b: color.2,
            },
        });
    }

    let seq = Sequence {
        id: format!("audio-{id}"),
        name: format!("Beat sync — {}", track.filename),
        duration_ms,
        clips,
    };

    let saved = state
        .store
        .save(seq)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    Ok(Json(saved))
}

/// `POST /api/audio/:id/play` — play the auto-generated beat-synced sequence
/// (generates it first if it doesn't exist yet).
async fn play_audio_sequence(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<StatusResponse>, (StatusCode, String)> {
    let seq_id = format!("audio-{id}");

    // Generate if missing.
    if state.store.get(&seq_id).is_none() {
        let _ = generate_sequence(State(state.clone()), Path(id)).await?;
    }

    let seq = state.store.get(&seq_id).ok_or((
        StatusCode::INTERNAL_SERVER_ERROR,
        "sequence missing after generate".into(),
    ))?;

    with_show(&state, |s| s.play_sequence(seq, false));
    Ok(get_status(State(state)).await)
}
