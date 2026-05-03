//! Timeline sequence data model (Phase 3).
//!
//! A [`Sequence`] is an ordered list of [`Clip`]s on a single timeline. Each
//! clip pins one effect with its parameters to a `[start_ms, start_ms +
//! duration_ms)` time window. At any moment `t` the sequencer resolves the
//! "active" clip (the latest clip whose window contains `t`) and renders that
//! effect; gaps between clips render black.
//!
//! This minimal model is intentionally single-track: layout-aware multi-group
//! sequencing arrives once the layout designer lands later in Phase 3.

use controller::Rgb;
use serde::{Deserialize, Serialize};

use crate::EffectKind;

/// Wire-friendly RGB struct used for sequence/clip JSON.
///
/// We don't serialize [`Rgb`] directly so that JSON stays human-readable
/// (`{"r":255,"g":0,"b":0}` instead of a 3-tuple).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct ClipColor {
    pub r: u8,
    pub g: u8,
    pub b: u8,
}

impl From<Rgb> for ClipColor {
    fn from(c: Rgb) -> Self {
        Self {
            r: c.0,
            g: c.1,
            b: c.2,
        }
    }
}

impl From<ClipColor> for Rgb {
    fn from(c: ClipColor) -> Self {
        Rgb(c.r, c.g, c.b)
    }
}

/// A single timed effect on the timeline.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Clip {
    /// Stable identifier (UI uses this for drag/drop bookkeeping).
    pub id: String,
    /// Start time in milliseconds from the sequence origin.
    pub start_ms: u64,
    /// Length in milliseconds. Must be > 0 for [`Sequence::validate`].
    pub duration_ms: u64,
    /// Effect to play during this clip.
    pub kind: EffectKind,
    /// Color seed for color-aware effects.
    pub color: ClipColor,
}

impl Clip {
    /// Inclusive-exclusive end time in milliseconds.
    #[must_use]
    pub fn end_ms(&self) -> u64 {
        self.start_ms.saturating_add(self.duration_ms)
    }

    /// Whether `t_ms` falls inside `[start_ms, end_ms)`.
    #[must_use]
    pub fn contains(&self, t_ms: u64) -> bool {
        t_ms >= self.start_ms && t_ms < self.end_ms()
    }
}

/// Validation errors returned by [`Sequence::validate`].
#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum SequenceError {
    #[error("sequence id must not be empty")]
    EmptyId,
    #[error("sequence name must not be empty")]
    EmptyName,
    #[error("clip {0} has zero duration")]
    ZeroDurationClip(String),
    #[error("clip ids must be unique; '{0}' is duplicated")]
    DuplicateClipId(String),
}

/// A named, savable timeline of clips.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Sequence {
    pub id: String,
    pub name: String,
    /// Total declared length. Playback uses this for looping — extra space
    /// past the last clip just plays black.
    pub duration_ms: u64,
    pub clips: Vec<Clip>,
}

impl Sequence {
    /// Build a new empty sequence.
    #[must_use]
    pub fn empty(id: impl Into<String>, name: impl Into<String>, duration_ms: u64) -> Self {
        Self {
            id: id.into(),
            name: name.into(),
            duration_ms,
            clips: Vec::new(),
        }
    }

    /// Reject malformed sequences. Cheap; called by the store on save.
    pub fn validate(&self) -> Result<(), SequenceError> {
        if self.id.trim().is_empty() {
            return Err(SequenceError::EmptyId);
        }
        if self.name.trim().is_empty() {
            return Err(SequenceError::EmptyName);
        }

        let mut seen = std::collections::HashSet::new();
        for clip in &self.clips {
            if clip.duration_ms == 0 {
                return Err(SequenceError::ZeroDurationClip(clip.id.clone()));
            }
            if !seen.insert(clip.id.as_str()) {
                return Err(SequenceError::DuplicateClipId(clip.id.clone()));
            }
        }
        Ok(())
    }

    /// Total play length, taking the larger of `duration_ms` and the latest
    /// clip's end. Returns 0 for sequences with no length and no clips.
    #[must_use]
    pub fn effective_duration_ms(&self) -> u64 {
        self.clips
            .iter()
            .map(Clip::end_ms)
            .max()
            .unwrap_or(0)
            .max(self.duration_ms)
    }

    /// Find the clip active at `t_ms`. If multiple clips overlap, the latest
    /// (largest `start_ms`) wins so the timeline behaves like layered tracks
    /// in a typical DAW.
    #[must_use]
    pub fn clip_at(&self, t_ms: u64) -> Option<&Clip> {
        self.clips
            .iter()
            .filter(|c| c.contains(t_ms))
            .max_by_key(|c| c.start_ms)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn clip(id: &str, start: u64, dur: u64) -> Clip {
        Clip {
            id: id.into(),
            start_ms: start,
            duration_ms: dur,
            kind: EffectKind::Solid,
            color: ClipColor { r: 255, g: 0, b: 0 },
        }
    }

    #[test]
    fn clip_contains_handles_endpoints() {
        let c = clip("a", 100, 200);
        assert!(!c.contains(99));
        assert!(c.contains(100));
        assert!(c.contains(299));
        assert!(!c.contains(300));
    }

    #[test]
    fn empty_sequence_is_valid() {
        let s = Sequence::empty("s1", "test", 5_000);
        s.validate().unwrap();
        assert_eq!(s.effective_duration_ms(), 5_000);
        assert!(s.clip_at(0).is_none());
    }

    #[test]
    fn rejects_zero_duration_and_dup_ids() {
        let mut s = Sequence::empty("s1", "test", 1_000);
        s.clips.push(clip("c1", 0, 0));
        assert_eq!(
            s.validate().unwrap_err(),
            SequenceError::ZeroDurationClip("c1".into())
        );

        let mut s = Sequence::empty("s1", "test", 1_000);
        s.clips.push(clip("c1", 0, 100));
        s.clips.push(clip("c1", 100, 100));
        assert_eq!(
            s.validate().unwrap_err(),
            SequenceError::DuplicateClipId("c1".into())
        );
    }

    #[test]
    fn clip_at_picks_overlap_winner() {
        let mut s = Sequence::empty("s1", "test", 1_000);
        s.clips.push(clip("base", 0, 1_000));
        s.clips.push(clip("top", 200, 100)); // overrides base in [200,300)

        assert_eq!(s.clip_at(100).unwrap().id, "base");
        assert_eq!(s.clip_at(250).unwrap().id, "top");
        assert_eq!(s.clip_at(300).unwrap().id, "base");
    }

    #[test]
    fn json_roundtrips() {
        let mut s = Sequence::empty("s1", "demo", 2_000);
        s.clips.push(clip("c1", 0, 1_000));
        let json = serde_json::to_string(&s).unwrap();
        let back: Sequence = serde_json::from_str(&json).unwrap();
        assert_eq!(s, back);
    }

    #[test]
    fn effective_duration_uses_latest_clip_end() {
        let mut s = Sequence::empty("s1", "demo", 500);
        s.clips.push(clip("c1", 0, 1_000));
        assert_eq!(s.effective_duration_ms(), 1_000);
    }
}
