//! Spotify OAuth 2.0 PKCE flow.
//!
//! Public-client friendly: no client secret required. The flow:
//!
//! 1. Generate a 64-char `code_verifier` and an `S256` `code_challenge`.
//! 2. Build the `/authorize` URL; redirect the browser there.
//! 3. Spotify redirects back to our `/callback?code=&state=`.
//! 4. We POST the `code` + `code_verifier` to `/api/token` and persist the
//!    resulting access/refresh tokens.

use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use chrono::Utc;
use rand::{Rng, distributions::Alphanumeric};
use serde::Deserialize;
use sha2::{Digest, Sha256};

use crate::{
    error::{Result, SpotifyError},
    token_store::{StoredToken, TokenStore},
};

/// Scopes required by the app: streaming via Web Playback SDK + basic
/// profile + playback control + email (for the "Premium?" check).
pub const DEFAULT_SCOPES: &str = "streaming user-read-email user-read-private \
     user-modify-playback-state user-read-playback-state \
     user-library-read";

const SPOTIFY_AUTHORIZE: &str = "https://accounts.spotify.com/authorize";
const SPOTIFY_TOKEN: &str = "https://accounts.spotify.com/api/token";
const STATE_TTL: Duration = Duration::from_secs(10 * 60);

/// One in-flight authorization. We keep these in a small in-memory map keyed
/// by the random `state` string and prune stale ones lazily.
#[derive(Debug, Clone)]
struct PendingAuth {
    code_verifier: String,
    created: Instant,
}

#[derive(Debug, Deserialize)]
struct TokenResponse {
    access_token: String,
    token_type: String,
    expires_in: i64,
    refresh_token: Option<String>,
    scope: Option<String>,
}

/// PKCE authentication helper. Cheap to clone — wraps shared state.
#[derive(Clone)]
pub struct Auth {
    inner: Arc<AuthInner>,
}

struct AuthInner {
    client_id: String,
    redirect_uri: String,
    http: reqwest::Client,
    pending: Mutex<HashMap<String, PendingAuth>>,
    store: TokenStore,
    cached: Mutex<Option<StoredToken>>,
}

impl Auth {
    pub fn new(client_id: String, redirect_uri: String, store: TokenStore) -> Result<Self> {
        if client_id.trim().is_empty() {
            return Err(SpotifyError::Config(
                "SPOTIFY_CLIENT_ID is empty — set it in .env or config.toml".into(),
            ));
        }
        let cached = store.load()?;
        let http = reqwest::Client::builder()
            .user_agent("christmas-lightshow-app/0.1 (+https://github.com/tylerwoody/christmas-lightshow-app)")
            .build()?;
        Ok(Self {
            inner: Arc::new(AuthInner {
                client_id,
                redirect_uri,
                http,
                pending: Mutex::new(HashMap::new()),
                store,
                cached: Mutex::new(cached),
            }),
        })
    }

    #[must_use]
    pub fn client_id(&self) -> &str {
        &self.inner.client_id
    }

    #[must_use]
    pub fn redirect_uri(&self) -> &str {
        &self.inner.redirect_uri
    }

    /// True if we have a stored access token (possibly stale; the next API
    /// call will refresh it if needed).
    pub fn is_authenticated(&self) -> bool {
        self.inner.cached.lock().unwrap().is_some()
    }

    /// Build a Spotify `/authorize` URL and stash the verifier under `state`.
    pub fn begin_login(&self) -> Result<String> {
        let verifier = generate_verifier();
        let challenge = code_challenge(&verifier);
        let state = generate_state();

        {
            let mut pending = self.inner.pending.lock().unwrap();
            prune_expired(&mut pending);
            pending.insert(
                state.clone(),
                PendingAuth {
                    code_verifier: verifier,
                    created: Instant::now(),
                },
            );
        }

        let url = url::Url::parse_with_params(
            SPOTIFY_AUTHORIZE,
            &[
                ("response_type", "code"),
                ("client_id", &self.inner.client_id),
                ("redirect_uri", &self.inner.redirect_uri),
                ("code_challenge_method", "S256"),
                ("code_challenge", &challenge),
                ("state", &state),
                ("scope", DEFAULT_SCOPES),
            ],
        )
        .map_err(|e| SpotifyError::Config(format!("authorize url: {e}")))?;
        Ok(url.to_string())
    }

    /// Exchange the `code` returned by Spotify for an access + refresh token.
    /// Verifies CSRF state and persists the resulting token bundle.
    pub async fn complete_login(&self, code: &str, state: &str) -> Result<StoredToken> {
        let verifier = {
            let mut pending = self.inner.pending.lock().unwrap();
            prune_expired(&mut pending);
            pending
                .remove(state)
                .ok_or(SpotifyError::UnknownState)?
                .code_verifier
        };

        let params = [
            ("grant_type", "authorization_code"),
            ("code", code),
            ("redirect_uri", &self.inner.redirect_uri),
            ("client_id", &self.inner.client_id),
            ("code_verifier", &verifier),
        ];

        let resp = self
            .inner
            .http
            .post(SPOTIFY_TOKEN)
            .form(&params)
            .send()
            .await?;
        let token = parse_token_response(resp).await?;
        let stored = into_stored(token, None);
        self.inner.store.save(&stored)?;
        *self.inner.cached.lock().unwrap() = Some(stored.clone());
        Ok(stored)
    }

    /// Return a valid access token, refreshing if necessary. Returns
    /// `NotAuthenticated` if no token has been stored yet.
    pub async fn access_token(&self) -> Result<String> {
        let snapshot = self.inner.cached.lock().unwrap().clone();
        let Some(stored) = snapshot else {
            return Err(SpotifyError::NotAuthenticated);
        };
        if !stored.needs_refresh() {
            return Ok(stored.access_token);
        }
        let refreshed = self.refresh(&stored).await?;
        Ok(refreshed.access_token)
    }

    /// Forget the stored token (logout).
    pub fn logout(&self) -> Result<()> {
        self.inner.store.clear()?;
        *self.inner.cached.lock().unwrap() = None;
        Ok(())
    }

    async fn refresh(&self, current: &StoredToken) -> Result<StoredToken> {
        let refresh_token = current
            .refresh_token
            .as_deref()
            .ok_or(SpotifyError::NotAuthenticated)?;
        let params = [
            ("grant_type", "refresh_token"),
            ("refresh_token", refresh_token),
            ("client_id", &self.inner.client_id),
        ];
        let resp = self
            .inner
            .http
            .post(SPOTIFY_TOKEN)
            .form(&params)
            .send()
            .await?;
        let token = parse_token_response(resp).await?;
        // Spotify may omit refresh_token in refresh responses → keep old one.
        let stored = into_stored(token, Some(refresh_token.to_string()));
        self.inner.store.save(&stored)?;
        *self.inner.cached.lock().unwrap() = Some(stored.clone());
        Ok(stored)
    }
}

async fn parse_token_response(resp: reqwest::Response) -> Result<TokenResponse> {
    let status = resp.status();
    if !status.is_success() {
        let body = resp.text().await.unwrap_or_default();
        return Err(SpotifyError::Api {
            status: status.as_u16(),
            body,
        });
    }
    let token: TokenResponse = resp.json().await?;
    if !token.token_type.eq_ignore_ascii_case("bearer") {
        return Err(SpotifyError::Api {
            status: 200,
            body: format!("unexpected token_type {}", token.token_type),
        });
    }
    Ok(token)
}

fn into_stored(token: TokenResponse, fallback_refresh: Option<String>) -> StoredToken {
    let expires_at = Utc::now() + chrono::Duration::seconds(token.expires_in);
    StoredToken {
        access_token: token.access_token,
        refresh_token: token.refresh_token.or(fallback_refresh),
        scope: token.scope.unwrap_or_else(|| DEFAULT_SCOPES.into()),
        expires_at,
    }
}

fn generate_verifier() -> String {
    rand::thread_rng()
        .sample_iter(&Alphanumeric)
        .take(64)
        .map(char::from)
        .collect()
}

fn generate_state() -> String {
    rand::thread_rng()
        .sample_iter(&Alphanumeric)
        .take(32)
        .map(char::from)
        .collect()
}

fn code_challenge(verifier: &str) -> String {
    let digest = Sha256::digest(verifier.as_bytes());
    URL_SAFE_NO_PAD.encode(digest)
}

fn prune_expired(map: &mut HashMap<String, PendingAuth>) {
    let now = Instant::now();
    map.retain(|_, v| now.duration_since(v.created) < STATE_TTL);
}
