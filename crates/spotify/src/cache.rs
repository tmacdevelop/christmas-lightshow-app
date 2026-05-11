//! On-disk cache for Spotify `audio-analysis` results.
//!
//! Spotify's analysis is expensive to fetch and never changes for a given
//! track id, so we store the JSON verbatim under `<dir>/<track_id>.json`.

use std::path::{Path, PathBuf};

use crate::{analysis::AudioAnalysis, error::Result};

pub struct AnalysisCache {
    dir: PathBuf,
}

impl AnalysisCache {
    pub fn open(dir: impl Into<PathBuf>) -> Result<Self> {
        let dir = dir.into();
        std::fs::create_dir_all(&dir)?;
        Ok(Self { dir })
    }

    #[must_use]
    pub fn dir(&self) -> &Path {
        &self.dir
    }

    fn path(&self, track_id: &str) -> PathBuf {
        // Restrict to the alnum + dash + underscore set Spotify ids use.
        let safe: String = track_id
            .chars()
            .filter(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_'))
            .collect();
        self.dir.join(format!("{safe}.json"))
    }

    pub fn get(&self, track_id: &str) -> Result<Option<AudioAnalysis>> {
        let path = self.path(track_id);
        if !path.exists() {
            return Ok(None);
        }
        let raw = std::fs::read(&path)?;
        let analysis: AudioAnalysis = serde_json::from_slice(&raw)?;
        Ok(Some(analysis))
    }

    pub fn put(&self, track_id: &str, analysis: &AudioAnalysis) -> Result<()> {
        let path = self.path(track_id);
        let raw = serde_json::to_vec_pretty(analysis)?;
        std::fs::write(path, raw)?;
        Ok(())
    }
}
