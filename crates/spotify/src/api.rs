//! Thin wrapper over selected `api.spotify.com` endpoints we proxy.

use serde::{Deserialize, Serialize};

use crate::{
    analysis::AudioAnalysis,
    auth::Auth,
    error::{Result, SpotifyError},
};

const API_BASE: &str = "https://api.spotify.com/v1";

#[derive(Clone)]
pub struct ApiClient {
    auth: Auth,
    http: reqwest::Client,
}

impl ApiClient {
    pub fn new(auth: Auth) -> Self {
        let http = reqwest::Client::builder()
            .user_agent("christmas-lightshow-app/0.1")
            .build()
            .expect("reqwest client");
        Self { auth, http }
    }

    pub fn auth(&self) -> &Auth {
        &self.auth
    }

    /// `GET /v1/me` — returns the authenticated user's profile.
    pub async fn me(&self) -> Result<UserProfile> {
        self.get_json("/me").await
    }

    /// `GET /v1/search?q=&type=track&limit=`.
    pub async fn search_tracks(&self, query: &str, limit: u32) -> Result<SearchResponse> {
        let limit = limit.clamp(1, 50);
        let path = format!("/search?type=track&limit={}&q={}", limit, urlencode(query));
        self.get_json(&path).await
    }

    /// `GET /v1/tracks/:id`.
    pub async fn track(&self, id: &str) -> Result<Track> {
        self.get_json(&format!("/tracks/{}", urlencode(id))).await
    }

    /// `GET /v1/audio-analysis/:id`.
    pub async fn audio_analysis(&self, id: &str) -> Result<AudioAnalysis> {
        self.get_json(&format!("/audio-analysis/{}", urlencode(id)))
            .await
    }

    /// `GET /v1/me/tracks` — the user's "Liked Songs" library, paginated.
    /// `limit` is clamped to Spotify's 1..=50 range.
    pub async fn saved_tracks(&self, limit: u32, offset: u32) -> Result<SavedTracksPage> {
        let limit = limit.clamp(1, 50);
        self.get_json(&format!("/me/tracks?limit={limit}&offset={offset}"))
            .await
    }

    /// `GET /v1/me/albums` — the user's saved albums, paginated.
    pub async fn saved_albums(&self, limit: u32, offset: u32) -> Result<SavedAlbumsPage> {
        let limit = limit.clamp(1, 50);
        self.get_json(&format!("/me/albums?limit={limit}&offset={offset}"))
            .await
    }

    /// `GET /v1/albums/:id/tracks` — track listing for an album. Returns
    /// simplified tracks (no album field), so we splice in the album image
    /// at the route layer when we need it.
    pub async fn album_tracks(&self, id: &str, limit: u32, offset: u32) -> Result<AlbumTracksPage> {
        let limit = limit.clamp(1, 50);
        self.get_json(&format!(
            "/albums/{}/tracks?limit={limit}&offset={offset}",
            urlencode(id)
        ))
        .await
    }

    /// Helper: GET an `api.spotify.com` path and decode JSON.
    pub async fn get_json<T: for<'de> Deserialize<'de>>(&self, path: &str) -> Result<T> {
        let token = self.auth.access_token().await?;
        let url = format!("{API_BASE}{path}");
        let resp = self.http.get(&url).bearer_auth(token).send().await?;
        let status = resp.status();
        if !status.is_success() {
            let body = resp.text().await.unwrap_or_default();
            return Err(SpotifyError::Api {
                status: status.as_u16(),
                body,
            });
        }
        Ok(resp.json::<T>().await?)
    }
}

fn urlencode(s: &str) -> String {
    url::form_urlencoded::byte_serialize(s.as_bytes()).collect()
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct UserProfile {
    pub id: String,
    #[serde(default)]
    pub display_name: Option<String>,
    #[serde(default)]
    pub email: Option<String>,
    #[serde(default)]
    pub product: Option<String>,
    #[serde(default)]
    pub images: Vec<Image>,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
pub struct Image {
    pub url: String,
    #[serde(default)]
    pub height: Option<u32>,
    #[serde(default)]
    pub width: Option<u32>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct SearchResponse {
    pub tracks: TrackPage,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct TrackPage {
    pub items: Vec<Track>,
    #[serde(default)]
    pub total: u32,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct Track {
    pub id: String,
    pub name: String,
    pub uri: String,
    #[serde(default)]
    pub duration_ms: u64,
    #[serde(default)]
    pub explicit: bool,
    #[serde(default)]
    pub preview_url: Option<String>,
    #[serde(default)]
    pub artists: Vec<Artist>,
    #[serde(default)]
    pub album: Option<Album>,
    /// External ids (notably `isrc`) used to look the track up on
    /// other audio databases as a fallback when Spotify's own
    /// `audio-analysis` endpoint is unavailable (deprecated for new
    /// apps in late 2024).
    #[serde(default)]
    pub external_ids: ExternalIds,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
pub struct ExternalIds {
    #[serde(default)]
    pub isrc: Option<String>,
    #[serde(default)]
    pub ean: Option<String>,
    #[serde(default)]
    pub upc: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct Artist {
    pub id: String,
    pub name: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct Album {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub images: Vec<Image>,
    #[serde(default)]
    pub release_date: Option<String>,
}

/// One row of `GET /me/tracks`. Spotify wraps each track in `{added_at, track}`.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct SavedTrackItem {
    #[serde(default)]
    pub added_at: Option<String>,
    pub track: Track,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct SavedTracksPage {
    pub items: Vec<SavedTrackItem>,
    #[serde(default)]
    pub total: u32,
    #[serde(default)]
    pub limit: u32,
    #[serde(default)]
    pub offset: u32,
}

/// One row of `GET /me/albums`. Includes a nested album with its own
/// (simplified) track listing in `album.tracks.items`.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct SavedAlbumItem {
    #[serde(default)]
    pub added_at: Option<String>,
    pub album: SavedAlbum,
}

/// Slightly richer album shape returned by `GET /me/albums` and
/// `GET /albums/:id`. Includes artists and a (possibly partial) track page.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct SavedAlbum {
    pub id: String,
    pub name: String,
    pub uri: String,
    #[serde(default)]
    pub images: Vec<Image>,
    #[serde(default)]
    pub release_date: Option<String>,
    #[serde(default)]
    pub total_tracks: u32,
    #[serde(default)]
    pub artists: Vec<Artist>,
    #[serde(default)]
    pub tracks: Option<AlbumTracksPage>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct SavedAlbumsPage {
    pub items: Vec<SavedAlbumItem>,
    #[serde(default)]
    pub total: u32,
    #[serde(default)]
    pub limit: u32,
    #[serde(default)]
    pub offset: u32,
}

/// Page of tracks inside an album (simplified — no album field, no preview).
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct AlbumTracksPage {
    pub items: Vec<AlbumTrack>,
    #[serde(default)]
    pub total: u32,
    #[serde(default)]
    pub limit: u32,
    #[serde(default)]
    pub offset: u32,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct AlbumTrack {
    pub id: String,
    pub name: String,
    pub uri: String,
    #[serde(default)]
    pub duration_ms: u64,
    #[serde(default)]
    pub track_number: u32,
    #[serde(default)]
    pub disc_number: u32,
    #[serde(default)]
    pub explicit: bool,
    #[serde(default)]
    pub artists: Vec<Artist>,
}
