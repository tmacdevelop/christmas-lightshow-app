//! Filesystem-backed sequence store for the Phase 3 REST API.
//!
//! Each [`Sequence`] is persisted as a single JSON file at
//! `<root>/<sequence_id>.json`. The store keeps an in-memory index for fast
//! `list`/`get` and writes synchronously on `save`/`delete`. SQLite-backed
//! storage is planned for later in Phase 3 — JSON-on-disk lets us iterate on
//! the data model without yanking in `sqlx` yet.

use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::Mutex,
};

use sequencer::{Sequence, SequenceError};

/// Errors returned by [`SequenceStore`] operations.
#[derive(Debug, thiserror::Error)]
pub enum StoreError {
    #[error("sequence id contains illegal characters: {0}")]
    BadId(String),
    #[error("sequence not found: {0}")]
    NotFound(String),
    #[error("invalid sequence: {0}")]
    Invalid(#[from] SequenceError),
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
    #[error("json: {0}")]
    Json(#[from] serde_json::Error),
}

/// Thread-safe sequence store keyed by `sequence.id`.
pub struct SequenceStore {
    root: PathBuf,
    index: Mutex<HashMap<String, Sequence>>,
}

impl SequenceStore {
    /// Open (and create if missing) a store rooted at `root`. Loads any
    /// `*.json` files into the in-memory index, skipping files that fail to
    /// parse so a single bad file can't crash startup.
    pub fn open(root: impl Into<PathBuf>) -> Result<Self, StoreError> {
        let root = root.into();
        std::fs::create_dir_all(&root)?;

        let mut index = HashMap::new();
        for entry in std::fs::read_dir(&root)? {
            let entry = entry?;
            let path = entry.path();
            if path.extension().and_then(|s| s.to_str()) != Some("json") {
                continue;
            }
            match read_sequence(&path) {
                Ok(seq) => {
                    index.insert(seq.id.clone(), seq);
                }
                Err(err) => {
                    tracing::warn!(?path, %err, "skipping malformed sequence file");
                }
            }
        }

        Ok(Self {
            root,
            index: Mutex::new(index),
        })
    }

    /// Return all sequences sorted by name (case-insensitive).
    pub fn list(&self) -> Vec<Sequence> {
        let guard = self.lock();
        let mut out: Vec<Sequence> = guard.values().cloned().collect();
        out.sort_by_key(|a| a.name.to_lowercase());
        out
    }

    /// Fetch a single sequence by id.
    pub fn get(&self, id: &str) -> Option<Sequence> {
        self.lock().get(id).cloned()
    }

    /// Persist a sequence (insert or overwrite).
    pub fn save(&self, seq: Sequence) -> Result<Sequence, StoreError> {
        seq.validate()?;
        if !is_safe_id(&seq.id) {
            return Err(StoreError::BadId(seq.id));
        }

        let path = self.path_for(&seq.id);
        write_sequence(&path, &seq)?;

        let mut guard = self.lock();
        guard.insert(seq.id.clone(), seq.clone());
        Ok(seq)
    }

    /// Remove a sequence by id. Returns the removed sequence.
    pub fn delete(&self, id: &str) -> Result<Sequence, StoreError> {
        if !is_safe_id(id) {
            return Err(StoreError::BadId(id.into()));
        }
        let mut guard = self.lock();
        let removed = guard
            .remove(id)
            .ok_or_else(|| StoreError::NotFound(id.into()))?;
        let path = self.path_for(id);
        if path.exists() {
            std::fs::remove_file(&path)?;
        }
        Ok(removed)
    }

    fn path_for(&self, id: &str) -> PathBuf {
        self.root.join(format!("{id}.json"))
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<String, Sequence>> {
        match self.index.lock() {
            Ok(g) => g,
            Err(poisoned) => poisoned.into_inner(),
        }
    }
}

fn read_sequence(path: &Path) -> Result<Sequence, StoreError> {
    let raw = std::fs::read_to_string(path)?;
    let seq: Sequence = serde_json::from_str(&raw)?;
    seq.validate()?;
    Ok(seq)
}

fn write_sequence(path: &Path, seq: &Sequence) -> Result<(), StoreError> {
    let json = serde_json::to_string_pretty(seq)?;
    // Write to a temp file then rename so a crash mid-write doesn't corrupt
    // an existing sequence.
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, json)?;
    std::fs::rename(&tmp, path)?;
    Ok(())
}

/// Restrict ids to a safe subset so they can be used directly as filenames
/// without risk of path traversal or platform-specific oddities.
fn is_safe_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 128
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

#[cfg(test)]
mod tests {
    use super::*;
    use sequencer::{Clip, ClipColor, EffectKind};

    fn tmpdir() -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "lightshow-store-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn sample(id: &str) -> Sequence {
        let mut s = Sequence::empty(id, "Sample", 1_000);
        s.clips.push(Clip {
            id: "c1".into(),
            start_ms: 0,
            duration_ms: 500,
            kind: EffectKind::Solid,
            color: ClipColor { r: 1, g: 2, b: 3 },
            pattern: None,
        });
        s
    }

    #[test]
    fn save_get_list_delete_roundtrip() {
        let dir = tmpdir();
        let store = SequenceStore::open(&dir).unwrap();

        store.save(sample("a")).unwrap();
        store.save(sample("b")).unwrap();

        assert_eq!(store.list().len(), 2);
        let a = store.get("a").unwrap();
        assert_eq!(a.name, "Sample");

        store.delete("a").unwrap();
        assert!(store.get("a").is_none());
        assert_eq!(store.list().len(), 1);

        // Reopening should re-load remaining file.
        drop(store);
        let store2 = SequenceStore::open(&dir).unwrap();
        assert_eq!(store2.list().len(), 1);
        assert!(store2.get("b").is_some());

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn rejects_bad_ids() {
        let dir = tmpdir();
        let store = SequenceStore::open(&dir).unwrap();
        let bad = Sequence::empty("../etc/passwd", "ouch", 0);
        assert!(matches!(store.save(bad), Err(StoreError::BadId(_))));
        std::fs::remove_dir_all(&dir).ok();
    }
}
