//! Errors surfaced by the Spotify integration crate.

use thiserror::Error;

#[derive(Debug, Error)]
pub enum SpotifyError {
    #[error("not authenticated with Spotify")]
    NotAuthenticated,

    #[error("authorization state mismatch (possible CSRF)")]
    StateMismatch,

    #[error("authorization state expired or unknown")]
    UnknownState,

    #[error("Spotify API returned {status}: {body}")]
    Api { status: u16, body: String },

    #[error("HTTP error: {0}")]
    Http(#[from] reqwest::Error),

    #[error("token storage error: {0}")]
    Storage(String),

    #[error("crypto error: {0}")]
    Crypto(String),

    #[error("invalid configuration: {0}")]
    Config(String),

    #[error("io error: {0}")]
    Io(#[from] std::io::Error),

    #[error("serde error: {0}")]
    Serde(#[from] serde_json::Error),
}

pub type Result<T> = std::result::Result<T, SpotifyError>;
