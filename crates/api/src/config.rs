//! Runtime configuration loaded from `config.toml`.

use std::{
    net::SocketAddr,
    path::{Path, PathBuf},
};

use sequencer::EffectKind;
use serde::Deserialize;

#[derive(Debug, Deserialize)]
pub struct Config {
    pub pixel_count: usize,
    pub fps: u32,
    pub bind: SocketAddr,
    #[serde(default)]
    pub effect: EffectKind,
    /// Directory holding sequence JSON files. Defaults to `./shows`.
    #[serde(default = "default_shows_dir")]
    pub shows_dir: PathBuf,
    /// Directory holding layout JSON files. Defaults to `./layouts`.
    #[serde(default = "default_layouts_dir")]
    pub layouts_dir: PathBuf,
    /// Directory holding uploaded audio files + analysis. Defaults to `./audio`.
    #[serde(default = "default_audio_dir")]
    pub audio_dir: PathBuf,
    /// Spotify integration settings (SPOTIFY_PLAN.md).
    #[serde(default)]
    pub spotify: SpotifyConfig,
}

#[derive(Debug, Deserialize)]
pub struct SpotifyConfig {
    #[serde(default = "default_spotify_redirect_uri")]
    pub redirect_uri: String,
    #[serde(default = "default_spotify_cache_dir")]
    pub cache_dir: PathBuf,
    #[serde(default = "default_spotify_token_path")]
    pub token_path: PathBuf,
    /// Origin (scheme + host + port) to redirect the browser back to after
    /// the OAuth callback. Set to e.g. `http://localhost:4200` so the dev
    /// UI receives the `?spotify=ok` query. When `None`, a relative URL
    /// (`/?spotify=ok`) is used — appropriate when the API also serves the
    /// SPA.
    #[serde(default)]
    pub ui_origin: Option<String>,
}

impl Default for SpotifyConfig {
    fn default() -> Self {
        Self {
            redirect_uri: default_spotify_redirect_uri(),
            cache_dir: default_spotify_cache_dir(),
            token_path: default_spotify_token_path(),
            ui_origin: None,
        }
    }
}

fn default_spotify_redirect_uri() -> String {
    "http://127.0.0.1:3000/api/spotify/auth/callback".into()
}

fn default_spotify_cache_dir() -> PathBuf {
    PathBuf::from("spotify-cache")
}

fn default_spotify_token_path() -> PathBuf {
    PathBuf::from("spotify-token.bin")
}

fn default_shows_dir() -> PathBuf {
    PathBuf::from("shows")
}

fn default_audio_dir() -> PathBuf {
    PathBuf::from("audio")
}

fn default_layouts_dir() -> PathBuf {
    PathBuf::from("layouts")
}

impl Config {
    pub fn load(path: impl AsRef<Path>) -> anyhow::Result<Self> {
        let path = path.as_ref();
        let raw = std::fs::read_to_string(path)
            .map_err(|e| anyhow::anyhow!("reading {}: {e}", path.display()))?;
        let cfg: Config =
            toml::from_str(&raw).map_err(|e| anyhow::anyhow!("parsing {}: {e}", path.display()))?;

        anyhow::ensure!(cfg.pixel_count > 0, "pixel_count must be > 0");
        anyhow::ensure!(cfg.fps > 0, "fps must be > 0");
        Ok(cfg)
    }
}
