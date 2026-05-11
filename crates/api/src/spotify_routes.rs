//! REST endpoints that proxy Spotify Web API + drive the auth flow.
//!
//! See [`SPOTIFY_PLAN.md`](../../../../SPOTIFY_PLAN.md) for the full design.
//!
//! Endpoints (all under `/api/spotify`):
//!
//! | Method | Path                              | Purpose |
//! |--------|-----------------------------------|---------|
//! | GET    | `/auth/login`                     | Returns `{ authorize_url }` |
//! | GET    | `/auth/callback?code=&state=`     | OAuth redirect target |
//! | GET    | `/auth/status`                    | `{ authenticated, user? }` |
//! | POST   | `/auth/logout`                    | Clear stored token |
//! | GET    | `/search?q=&limit=`               | Track search proxy |
//! | GET    | `/track/:id`                      | Track metadata |
//! | POST   | `/track/:id/sequence`             | Build + save Sequence from Deezer BPM (by ISRC) |
//!
//! Note: Spotify deprecated `/v1/audio-analysis` for new apps in Nov 2024,
//! so this app uses Deezer's free `/track/isrc:{isrc}` endpoint as the
//! sole analysis source. The synthesized analyses are cached on disk
//! (see [`spotify::AnalysisCache`]).

use axum::{
    Json, Router,
    extract::{Path, Query, State},
    http::StatusCode,
    response::{IntoResponse, Redirect, Response},
    routing::{get, post},
};
use serde::{Deserialize, Serialize};
use spotify::{SpotifyError, api::Track};

use crate::state::AppState;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/auth/login", get(auth_login))
        .route("/auth/callback", get(auth_callback))
        .route("/auth/status", get(auth_status))
        .route("/auth/logout", post(auth_logout))
        .route("/auth/token", get(auth_token))
        .route("/search", get(search))
        .route("/library/tracks", get(library_tracks))
        .route("/library/albums", get(library_albums))
        .route("/album/{id}/tracks", get(album_tracks))
        .route("/track/{id}", get(get_track))
        .route("/track/{id}/sequence", post(build_track_sequence))
}

#[derive(Serialize)]
struct LoginResponse {
    authorize_url: String,
}

async fn auth_login(State(state): State<AppState>) -> Result<Json<LoginResponse>, ApiError> {
    let spotify = state.spotify.as_ref().ok_or(ApiError::NotConfigured)?;
    let url = spotify.auth.begin_login()?;
    Ok(Json(LoginResponse { authorize_url: url }))
}

#[derive(Deserialize)]
struct CallbackParams {
    code: Option<String>,
    state: Option<String>,
    error: Option<String>,
}

/// Spotify redirects the browser here after the user grants/denies access.
/// We exchange the code, persist the token, then redirect back to the SPA
/// at `/?spotify=ok` (or `?spotify=error&reason=...`).
async fn auth_callback(
    State(state): State<AppState>,
    Query(params): Query<CallbackParams>,
) -> Response {
    let ui_origin = state.spotify.as_ref().and_then(|s| s.ui_origin.as_deref());
    let Some(spotify) = state.spotify.as_ref() else {
        return redirect_to_ui(ui_origin, "error", Some("not_configured"));
    };
    if let Some(err) = params.error {
        return redirect_to_ui(ui_origin, "error", Some(&err));
    }
    let (Some(code), Some(state_param)) = (params.code, params.state) else {
        return redirect_to_ui(ui_origin, "error", Some("missing_code_or_state"));
    };
    match spotify.auth.complete_login(&code, &state_param).await {
        Ok(_) => redirect_to_ui(ui_origin, "ok", None),
        Err(e) => {
            tracing::warn!(error = %e, "spotify callback failed");
            redirect_to_ui(ui_origin, "error", Some(&format!("{e}")))
        }
    }
}

fn redirect_to_ui(ui_origin: Option<&str>, status: &str, reason: Option<&str>) -> Response {
    let base = ui_origin.unwrap_or("");
    let mut url = format!("{base}/?spotify={status}");
    if let Some(reason) = reason {
        let r = url::form_urlencoded::byte_serialize(reason.as_bytes()).collect::<String>();
        url.push_str(&format!("&reason={r}"));
    }
    Redirect::to(&url).into_response()
}

#[derive(Serialize)]
struct AuthStatus {
    authenticated: bool,
    configured: bool,
    client_id: Option<String>,
    user: Option<spotify::UserProfile>,
}

async fn auth_status(State(state): State<AppState>) -> Json<AuthStatus> {
    let Some(spotify) = state.spotify.as_ref() else {
        return Json(AuthStatus {
            authenticated: false,
            configured: false,
            client_id: None,
            user: None,
        });
    };
    let authenticated = spotify.auth.is_authenticated();
    let user = if authenticated {
        match spotify.api.me().await {
            Ok(u) => Some(u),
            Err(e) => {
                tracing::warn!(error = %e, "fetching /me failed");
                None
            }
        }
    } else {
        None
    };
    Json(AuthStatus {
        authenticated,
        configured: true,
        client_id: Some(spotify.auth.client_id().into()),
        user,
    })
}

async fn auth_logout(State(state): State<AppState>) -> Result<StatusCode, ApiError> {
    let spotify = state.spotify.as_ref().ok_or(ApiError::NotConfigured)?;
    spotify.auth.logout()?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Serialize)]
struct TokenResponse {
    access_token: String,
    /// Approximate seconds until expiry; the UI should refresh shortly
    /// before this hits zero by re-calling `/auth/token`.
    expires_in: i64,
}

/// Expose the current access token to the browser so the Web Playback SDK
/// can use it via its `getOAuthToken` callback. Refreshes server-side if
/// the cached token is near expiry.
///
/// SECURITY NOTE: this is a single-user, localhost-only desktop tool. The
/// access token is already exposed to the browser by the SDK design; we are
/// not creating a new exposure surface beyond that. Do **not** mount this
/// route on a public deployment without adding session auth.
async fn auth_token(State(state): State<AppState>) -> Result<Json<TokenResponse>, ApiError> {
    let spotify = state.spotify.as_ref().ok_or(ApiError::NotConfigured)?;
    let access_token = spotify.auth.access_token().await?;
    Ok(Json(TokenResponse {
        access_token,
        // Spotify access tokens are 1 hour; we refresh at <60s remaining.
        expires_in: 3300,
    }))
}

#[derive(Deserialize)]
struct SearchParams {
    q: String,
    #[serde(default = "default_limit")]
    limit: u32,
}

fn default_limit() -> u32 {
    20
}

async fn search(
    State(state): State<AppState>,
    Query(params): Query<SearchParams>,
) -> Result<Json<spotify::SearchResponse>, ApiError> {
    let spotify = state.spotify.as_ref().ok_or(ApiError::NotConfigured)?;
    if params.q.trim().is_empty() {
        return Err(ApiError::BadRequest("query 'q' is required".into()));
    }
    let resp = spotify.api.search_tracks(&params.q, params.limit).await?;
    Ok(Json(resp))
}

#[derive(Deserialize)]
struct LibraryParams {
    #[serde(default = "default_lib_limit")]
    limit: u32,
    #[serde(default)]
    offset: u32,
}

fn default_lib_limit() -> u32 {
    50
}

async fn library_tracks(
    State(state): State<AppState>,
    Query(params): Query<LibraryParams>,
) -> Result<Json<spotify::api::SavedTracksPage>, ApiError> {
    let spotify = state.spotify.as_ref().ok_or(ApiError::NotConfigured)?;
    let page = spotify
        .api
        .saved_tracks(params.limit, params.offset)
        .await?;
    Ok(Json(page))
}

async fn library_albums(
    State(state): State<AppState>,
    Query(params): Query<LibraryParams>,
) -> Result<Json<spotify::api::SavedAlbumsPage>, ApiError> {
    let spotify = state.spotify.as_ref().ok_or(ApiError::NotConfigured)?;
    let page = spotify
        .api
        .saved_albums(params.limit, params.offset)
        .await?;
    Ok(Json(page))
}

async fn album_tracks(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Query(params): Query<LibraryParams>,
) -> Result<Json<spotify::api::AlbumTracksPage>, ApiError> {
    let spotify = state.spotify.as_ref().ok_or(ApiError::NotConfigured)?;
    let page = spotify
        .api
        .album_tracks(&id, params.limit, params.offset)
        .await?;
    Ok(Json(page))
}

async fn get_track(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<Track>, ApiError> {
    let spotify = state.spotify.as_ref().ok_or(ApiError::NotConfigured)?;
    Ok(Json(spotify.api.track(&id).await?))
}

#[derive(Serialize)]
struct BuildSequenceResponse {
    sequence_id: String,
    clip_count: usize,
    duration_ms: u64,
}

/// Build an `AudioAnalysis` from Deezer's BPM (keyed by the Spotify
/// track's ISRC), convert to a `Sequence`, and save it to the regular
/// sequence store so it appears in the timeline UI like any other show.
///
/// Spotify's own `/v1/audio-analysis` endpoint was deprecated for apps
/// registered after Nov 2024, so we don't call it — Deezer is the
/// primary (and only) analysis source. Successful results are cached on
/// disk so we don't re-query Deezer every time the user re-syncs.
async fn build_track_sequence(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<BuildSequenceResponse>, ApiError> {
    let spotify = state.spotify.as_ref().ok_or(ApiError::NotConfigured)?;
    let track = spotify.api.track(&id).await?;
    let analysis = match spotify.cache.get(&id)? {
        Some(a) => a,
        None => {
            let fresh = build_fallback_analysis(&track)
                .await
                .map_err(ApiError::Internal)?;
            spotify.cache.put(&id, &fresh)?;
            fresh
        }
    };
    let sequence = spotify::build_sequence(&analysis, &track);
    let clip_count = sequence.clips.len();
    let duration_ms = sequence.effective_duration_ms();
    let sequence_id = sequence.id.clone();
    state
        .store
        .save(sequence)
        .map_err(|e| ApiError::Internal(format!("save sequence: {e}")))?;
    Ok(Json(BuildSequenceResponse {
        sequence_id,
        clip_count,
        duration_ms,
    }))
}

/// Build an `AudioAnalysis` for a Spotify track using Deezer's BPM
/// (lookup by ISRC) and a synthetic uniform beat grid.
async fn build_fallback_analysis(track: &Track) -> Result<spotify::AudioAnalysis, String> {
    let isrc = track
        .external_ids
        .isrc
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "track has no ISRC; cannot look up on Deezer".to_string())?;
    let hit = spotify::lookup_isrc(isrc)
        .await
        .map_err(|e| format!("deezer lookup failed: {e}"))?
        .ok_or_else(|| format!("Deezer has no BPM for ISRC {isrc}"))?;
    tracing::info!(
        isrc,
        bpm = hit.bpm,
        "using Deezer BPM to synthesize analysis"
    );
    Ok(spotify::synthesize_analysis(track, hit))
}

// ---------------------------------------------------------------- errors --

#[derive(Debug)]
enum ApiError {
    NotConfigured,
    BadRequest(String),
    Spotify(SpotifyError),
    Internal(String),
}

impl From<SpotifyError> for ApiError {
    fn from(e: SpotifyError) -> Self {
        ApiError::Spotify(e)
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let (status, body) = match self {
            ApiError::NotConfigured => (
                StatusCode::SERVICE_UNAVAILABLE,
                "Spotify is not configured (missing SPOTIFY_CLIENT_ID)".to_string(),
            ),
            ApiError::BadRequest(msg) => (StatusCode::BAD_REQUEST, msg),
            ApiError::Spotify(SpotifyError::NotAuthenticated) => (
                StatusCode::UNAUTHORIZED,
                "not authenticated with Spotify".into(),
            ),
            ApiError::Spotify(SpotifyError::Api { status, body }) => (
                StatusCode::from_u16(status).unwrap_or(StatusCode::BAD_GATEWAY),
                body,
            ),
            ApiError::Spotify(e) => (StatusCode::BAD_GATEWAY, e.to_string()),
            ApiError::Internal(msg) => (StatusCode::INTERNAL_SERVER_ERROR, msg),
        };
        (status, body).into_response()
    }
}

use std::sync::Arc;

/// Bundle stored in [`AppState`] when Spotify is configured.
#[derive(Clone)]
pub struct SpotifyServices {
    pub auth: spotify::Auth,
    pub api: spotify::ApiClient,
    pub cache: Arc<spotify::AnalysisCache>,
    /// Optional absolute origin (e.g. `http://localhost:4200`) the OAuth
    /// callback should redirect to. `None` falls back to a relative URL.
    pub ui_origin: Option<String>,
}

impl SpotifyServices {
    pub fn from_env(
        client_id_env: Option<String>,
        redirect_uri: String,
        token_path: std::path::PathBuf,
        cache_dir: std::path::PathBuf,
        ui_origin: Option<String>,
    ) -> anyhow::Result<Option<Self>> {
        let Some(client_id) = client_id_env.filter(|s| !s.trim().is_empty()) else {
            tracing::warn!(
                "SPOTIFY_CLIENT_ID not set — Spotify integration disabled. \
                 Add it to .env to enable."
            );
            return Ok(None);
        };
        let store = spotify::TokenStore::open(&token_path)?;
        let auth = spotify::Auth::new(client_id, redirect_uri, store)?;
        let api = spotify::ApiClient::new(auth.clone());
        let cache = Arc::new(spotify::AnalysisCache::open(&cache_dir)?);
        Ok(Some(Self {
            auth,
            api,
            cache,
            ui_origin: ui_origin
                .map(|s| s.trim().trim_end_matches('/').to_string())
                .filter(|s| !s.is_empty()),
        }))
    }
}
