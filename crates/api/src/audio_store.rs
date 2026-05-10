//! Filesystem-backed store for uploaded audio tracks and their analysis.
//!
//! Layout on disk:
//! ```text
//! {audio_dir}/
//!   {id}.audio   — raw uploaded bytes (any format symphonia can decode)
//!   {id}.json    — serialised [`AudioTrack`] (includes the analysis)
//! ```

use std::{
    collections::HashMap,
    fs,
    path::{Path, PathBuf},
    sync::Mutex,
};

use audio::AudioAnalysis;
use serde::{Deserialize, Serialize};

/// Metadata + analysis for one uploaded audio track.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AudioTrack {
    pub id: String,
    /// Original filename supplied at upload time.
    pub filename: String,
    pub analysis: AudioAnalysis,
}

pub struct AudioStore {
    dir: PathBuf,
    index: Mutex<HashMap<String, AudioTrack>>,
}

impl AudioStore {
    /// Open (or create) the audio store at `dir`.
    pub fn open(dir: impl AsRef<Path>) -> anyhow::Result<Self> {
        let dir = dir.as_ref().to_path_buf();
        fs::create_dir_all(&dir)?;

        let mut index = HashMap::new();
        for entry in fs::read_dir(&dir)? {
            let entry = entry?;
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("json") {
                continue;
            }
            match fs::read_to_string(&path).and_then(|s| {
                serde_json::from_str::<AudioTrack>(&s)
                    .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))
            }) {
                Ok(track) => {
                    index.insert(track.id.clone(), track);
                }
                Err(e) => {
                    tracing::warn!(path = %path.display(), "skipping corrupt audio meta: {e}");
                }
            }
        }

        Ok(Self {
            dir,
            index: Mutex::new(index),
        })
    }

    /// Save a new track (raw bytes + metadata + analysis) to disk.
    pub fn save(
        &self,
        id: &str,
        filename: &str,
        raw_bytes: &[u8],
        analysis: AudioAnalysis,
    ) -> anyhow::Result<AudioTrack> {
        let track = AudioTrack {
            id: id.to_string(),
            filename: filename.to_string(),
            analysis,
        };

        // Write raw audio bytes.
        let audio_path = self.audio_path(id);
        let tmp_audio = audio_path.with_extension("audio.tmp");
        fs::write(&tmp_audio, raw_bytes)?;
        fs::rename(&tmp_audio, &audio_path)?;

        // Write JSON metadata atomically.
        let json_path = self.json_path(id);
        let tmp_json = json_path.with_extension("json.tmp");
        let json = serde_json::to_string_pretty(&track)?;
        fs::write(&tmp_json, json)?;
        fs::rename(&tmp_json, &json_path)?;

        self.index
            .lock()
            .unwrap()
            .insert(id.to_string(), track.clone());
        Ok(track)
    }

    /// List all stored audio tracks.
    pub fn list(&self) -> Vec<AudioTrack> {
        let mut tracks: Vec<_> = self.index.lock().unwrap().values().cloned().collect();
        tracks.sort_by(|a, b| a.filename.cmp(&b.filename));
        tracks
    }

    /// Fetch one track by id.
    pub fn get(&self, id: &str) -> Option<AudioTrack> {
        self.index.lock().unwrap().get(id).cloned()
    }

    /// Delete a track (both audio bytes and metadata) by id.
    pub fn delete(&self, id: &str) -> anyhow::Result<bool> {
        let removed = self.index.lock().unwrap().remove(id).is_some();
        if removed {
            let _ = fs::remove_file(self.audio_path(id));
            let _ = fs::remove_file(self.json_path(id));
        }
        Ok(removed)
    }

    /// Return the path to the raw audio bytes for `id`.
    pub fn audio_path(&self, id: &str) -> PathBuf {
        self.dir.join(format!("{id}.audio"))
    }

    fn json_path(&self, id: &str) -> PathBuf {
        self.dir.join(format!("{id}.json"))
    }
}
