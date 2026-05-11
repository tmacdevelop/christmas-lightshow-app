//! AES-GCM encrypted persistence for Spotify OAuth tokens.
//!
//! The token file layout is:
//!
//! ```text
//! [12 bytes nonce][ciphertext + 16 byte tag]
//! ```
//!
//! The encryption key is loaded from (in order):
//! 1. `SPOTIFY_TOKEN_KEY` env var (32 bytes hex), or
//! 2. A `<token_path>.key` file containing 32 random bytes; auto-generated
//!    on first run.
//!
//! This is "encryption at rest with key beside the door" — it doesn't stop
//! a determined local attacker, but it prevents accidental token leakage
//! via casual filesystem snooping or backup syncs that include the token
//! file but not the key file. It also keeps tokens out of plaintext logs.

use std::path::{Path, PathBuf};

use aes_gcm::{
    Aes256Gcm, KeyInit, Nonce,
    aead::{Aead, OsRng},
};
use chrono::{DateTime, Duration, Utc};
use rand::RngCore;
use serde::{Deserialize, Serialize};

use crate::error::{Result, SpotifyError};

/// OAuth token bundle stored on disk.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StoredToken {
    pub access_token: String,
    pub refresh_token: Option<String>,
    pub scope: String,
    pub expires_at: DateTime<Utc>,
}

impl StoredToken {
    /// True if the access token is expired or expires within the next 60s.
    #[must_use]
    pub fn needs_refresh(&self) -> bool {
        Utc::now() + Duration::seconds(60) >= self.expires_at
    }
}

/// Encrypted token persistence.
pub struct TokenStore {
    path: PathBuf,
    key_path: PathBuf,
    cipher: Aes256Gcm,
}

impl TokenStore {
    /// Open (or create) the token store at `path`. The key file is stored
    /// alongside as `<path>.key` unless `SPOTIFY_TOKEN_KEY` is set.
    pub fn open(path: impl Into<PathBuf>) -> Result<Self> {
        let path = path.into();
        let key_path = path.with_extension("key");
        let key = load_or_create_key(&key_path)?;
        let cipher = Aes256Gcm::new((&key).into());
        Ok(Self {
            path,
            key_path,
            cipher,
        })
    }

    /// Load the persisted token, if any.
    pub fn load(&self) -> Result<Option<StoredToken>> {
        if !self.path.exists() {
            return Ok(None);
        }
        let blob = std::fs::read(&self.path)?;
        if blob.len() < 12 {
            return Err(SpotifyError::Storage(
                "token file too short to contain nonce".into(),
            ));
        }
        let (nonce_bytes, ciphertext) = blob.split_at(12);
        let nonce = Nonce::from_slice(nonce_bytes);
        let plaintext = self
            .cipher
            .decrypt(nonce, ciphertext)
            .map_err(|e| SpotifyError::Crypto(format!("decrypt: {e}")))?;
        let token: StoredToken = serde_json::from_slice(&plaintext)?;
        Ok(Some(token))
    }

    /// Persist `token`, overwriting any existing file.
    pub fn save(&self, token: &StoredToken) -> Result<()> {
        let plaintext = serde_json::to_vec(token)?;
        let mut nonce_bytes = [0u8; 12];
        OsRng.fill_bytes(&mut nonce_bytes);
        let nonce = Nonce::from_slice(&nonce_bytes);
        let ciphertext = self
            .cipher
            .encrypt(nonce, plaintext.as_ref())
            .map_err(|e| SpotifyError::Crypto(format!("encrypt: {e}")))?;
        let mut out = Vec::with_capacity(12 + ciphertext.len());
        out.extend_from_slice(&nonce_bytes);
        out.extend_from_slice(&ciphertext);
        if let Some(parent) = self.path.parent()
            && !parent.as_os_str().is_empty()
        {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::write(&self.path, out)?;
        Ok(())
    }

    /// Remove the persisted token from disk (logout).
    pub fn clear(&self) -> Result<()> {
        if self.path.exists() {
            std::fs::remove_file(&self.path)?;
        }
        Ok(())
    }

    #[must_use]
    pub fn path(&self) -> &Path {
        &self.path
    }

    #[must_use]
    pub fn key_path(&self) -> &Path {
        &self.key_path
    }
}

fn load_or_create_key(key_path: &Path) -> Result<[u8; 32]> {
    if let Ok(hex) = std::env::var("SPOTIFY_TOKEN_KEY") {
        let bytes = decode_hex(hex.trim())
            .map_err(|e| SpotifyError::Config(format!("SPOTIFY_TOKEN_KEY: {e}")))?;
        if bytes.len() != 32 {
            return Err(SpotifyError::Config(
                "SPOTIFY_TOKEN_KEY must be 32 bytes (64 hex chars)".into(),
            ));
        }
        let mut key = [0u8; 32];
        key.copy_from_slice(&bytes);
        return Ok(key);
    }

    if key_path.exists() {
        let bytes = std::fs::read(key_path)?;
        if bytes.len() != 32 {
            return Err(SpotifyError::Config(format!(
                "key file {} must be exactly 32 bytes",
                key_path.display()
            )));
        }
        let mut key = [0u8; 32];
        key.copy_from_slice(&bytes);
        return Ok(key);
    }

    let mut key = [0u8; 32];
    OsRng.fill_bytes(&mut key);
    if let Some(parent) = key_path.parent()
        && !parent.as_os_str().is_empty()
    {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(key_path, key)?;
    Ok(key)
}

fn decode_hex(s: &str) -> std::result::Result<Vec<u8>, String> {
    if !s.len().is_multiple_of(2) {
        return Err("hex string must have even length".into());
    }
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).map_err(|e| e.to_string()))
        .collect()
}
