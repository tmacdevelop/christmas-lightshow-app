//! Filesystem-backed layout store, parallel to [`crate::store::SequenceStore`].
//!
//! Each [`Layout`] is persisted as `<root>/<layout_id>.json`. The store keeps
//! an in-memory index and writes atomically (temp file + rename) so a crash
//! mid-save can't corrupt an existing layout file. SQLite-backed storage is
//! planned for later in Phase 3.

use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::Mutex,
};

use sequencer::{Layout, LayoutError};

/// Errors returned by [`LayoutStore`] operations.
#[derive(Debug, thiserror::Error)]
pub enum LayoutStoreError {
    #[error("layout id contains illegal characters: {0}")]
    BadId(String),
    #[error("layout not found: {0}")]
    NotFound(String),
    #[error("invalid layout: {0}")]
    Invalid(#[from] LayoutError),
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
    #[error("json: {0}")]
    Json(#[from] serde_json::Error),
}

/// Thread-safe layout store keyed by `layout.id`.
pub struct LayoutStore {
    root: PathBuf,
    index: Mutex<HashMap<String, Layout>>,
}

impl LayoutStore {
    /// Open (and create if missing) a store rooted at `root`. Loads any
    /// `*.json` files into the in-memory index, skipping files that fail to
    /// parse so a single bad file can't crash startup.
    pub fn open(root: impl Into<PathBuf>) -> Result<Self, LayoutStoreError> {
        let root = root.into();
        std::fs::create_dir_all(&root)?;

        let mut index = HashMap::new();
        for entry in std::fs::read_dir(&root)? {
            let entry = entry?;
            let path = entry.path();
            if path.extension().and_then(|s| s.to_str()) != Some("json") {
                continue;
            }
            match read_layout(&path) {
                Ok(layout) => {
                    index.insert(layout.id.clone(), layout);
                }
                Err(err) => {
                    tracing::warn!(?path, %err, "skipping malformed layout file");
                }
            }
        }

        Ok(Self {
            root,
            index: Mutex::new(index),
        })
    }

    /// Return all layouts sorted by name (case-insensitive).
    pub fn list(&self) -> Vec<Layout> {
        let guard = self.lock();
        let mut out: Vec<Layout> = guard.values().cloned().collect();
        out.sort_by_key(|l| l.name.to_lowercase());
        out
    }

    /// Fetch a single layout by id.
    pub fn get(&self, id: &str) -> Option<Layout> {
        self.lock().get(id).cloned()
    }

    /// Persist a layout (insert or overwrite).
    pub fn save(&self, layout: Layout) -> Result<Layout, LayoutStoreError> {
        layout.validate()?;
        if !is_safe_id(&layout.id) {
            return Err(LayoutStoreError::BadId(layout.id));
        }

        let path = self.path_for(&layout.id);
        write_layout(&path, &layout)?;

        let mut guard = self.lock();
        guard.insert(layout.id.clone(), layout.clone());
        Ok(layout)
    }

    /// Remove a layout by id. Returns the removed layout.
    pub fn delete(&self, id: &str) -> Result<Layout, LayoutStoreError> {
        if !is_safe_id(id) {
            return Err(LayoutStoreError::BadId(id.into()));
        }
        let mut guard = self.lock();
        let removed = guard
            .remove(id)
            .ok_or_else(|| LayoutStoreError::NotFound(id.into()))?;
        let path = self.path_for(id);
        if path.exists() {
            std::fs::remove_file(&path)?;
        }
        Ok(removed)
    }

    fn path_for(&self, id: &str) -> PathBuf {
        self.root.join(format!("{id}.json"))
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<String, Layout>> {
        match self.index.lock() {
            Ok(g) => g,
            Err(poisoned) => poisoned.into_inner(),
        }
    }
}

fn read_layout(path: &Path) -> Result<Layout, LayoutStoreError> {
    let raw = std::fs::read_to_string(path)?;
    let layout: Layout = serde_json::from_str(&raw)?;
    layout.validate()?;
    Ok(layout)
}

fn write_layout(path: &Path, layout: &Layout) -> Result<(), LayoutStoreError> {
    let json = serde_json::to_string_pretty(layout)?;
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
    use sequencer::{Geometry, Point, Prop};

    fn tmpdir() -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "lightshow-layout-store-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn sample(id: &str) -> Layout {
        let mut l = Layout::empty(id, "Sample", 800.0, 600.0);
        l.props.push(Prop {
            id: "p1".into(),
            name: "strip".into(),
            pixel_offset: 0,
            pixel_count: 30,
            geometry: Geometry::Strip {
                start: Point { x: 50.0, y: 100.0 },
                end: Point { x: 750.0, y: 100.0 },
            },
        });
        l
    }

    #[test]
    fn save_get_list_delete_roundtrip() {
        let dir = tmpdir();
        let store = LayoutStore::open(&dir).unwrap();

        store.save(sample("a")).unwrap();
        store.save(sample("b")).unwrap();
        assert_eq!(store.list().len(), 2);

        let a = store.get("a").unwrap();
        assert_eq!(a.name, "Sample");

        store.delete("a").unwrap();
        assert!(store.get("a").is_none());

        // Reopen should re-read remaining file.
        drop(store);
        let store2 = LayoutStore::open(&dir).unwrap();
        assert_eq!(store2.list().len(), 1);

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn rejects_bad_ids() {
        let dir = tmpdir();
        let store = LayoutStore::open(&dir).unwrap();
        let bad = Layout::empty("../etc/passwd", "x", 100.0, 100.0);
        assert!(matches!(store.save(bad), Err(LayoutStoreError::BadId(_))));
        std::fs::remove_dir_all(&dir).ok();
    }
}
