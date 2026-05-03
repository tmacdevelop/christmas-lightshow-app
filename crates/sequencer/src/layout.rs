//! Layout / "room map" data model (Phase 3).
//!
//! A [`Layout`] describes how a flat pixel buffer (the same `Vec<Rgb>` produced
//! by the show engine) is physically arranged in 2D space. Each [`Prop`] owns
//! a contiguous slice of the global pixel buffer (`pixel_offset .. +pixel_count`)
//! and has a [`Geometry`] that tells the simulator (and, later, hardware
//! renderers) where each pixel sits on a virtual canvas.
//!
//! Phase 3 ships a single geometry — [`Geometry::Strip`] (a straight line
//! segment between two points) — which is enough for the apartment-scale
//! show in [PLAN.md](../../../PLAN.md). Strings, matrices, and curves slot
//! in as additional `Geometry` variants without touching the runtime.

use serde::{Deserialize, Serialize};

/// A 2D point in layout coordinates. Units are arbitrary (the UI scales the
/// layout to fit the canvas), but stay consistent within one layout.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Point {
    pub x: f32,
    pub y: f32,
}

/// How a prop's pixels are arranged on the canvas.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum Geometry {
    /// A straight line of `pixel_count` pixels, evenly spaced from `start`
    /// to `end` (inclusive).
    Strip { start: Point, end: Point },
}

/// One physical fixture (strip / string / matrix / etc.).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Prop {
    pub id: String,
    pub name: String,
    /// Offset of this prop's first pixel into the global show buffer.
    pub pixel_offset: usize,
    /// Number of pixels owned by this prop.
    pub pixel_count: usize,
    pub geometry: Geometry,
}

impl Prop {
    /// Inclusive-exclusive end index in the global pixel buffer.
    #[must_use]
    pub fn pixel_end(&self) -> usize {
        self.pixel_offset.saturating_add(self.pixel_count)
    }
}

/// A named, savable arrangement of props on a 2D canvas.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Layout {
    pub id: String,
    pub name: String,
    /// Canvas width in layout units.
    pub width: f32,
    /// Canvas height in layout units.
    pub height: f32,
    pub props: Vec<Prop>,
}

/// Validation errors returned by [`Layout::validate`].
#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum LayoutError {
    #[error("layout id must not be empty")]
    EmptyId,
    #[error("layout name must not be empty")]
    EmptyName,
    #[error("layout dimensions must be positive (got {0}x{1})")]
    BadDimensions(String, String),
    #[error("prop ids must be unique; '{0}' is duplicated")]
    DuplicatePropId(String),
    #[error("prop '{0}' has zero pixel_count")]
    ZeroPixelProp(String),
}

impl Layout {
    /// Build an empty layout with the given canvas dimensions.
    #[must_use]
    pub fn empty(id: impl Into<String>, name: impl Into<String>, width: f32, height: f32) -> Self {
        Self {
            id: id.into(),
            name: name.into(),
            width,
            height,
            props: Vec::new(),
        }
    }

    /// Reject malformed layouts. Cheap; callers (the store) run this on save.
    pub fn validate(&self) -> Result<(), LayoutError> {
        if self.id.trim().is_empty() {
            return Err(LayoutError::EmptyId);
        }
        if self.name.trim().is_empty() {
            return Err(LayoutError::EmptyName);
        }
        if !(self.width > 0.0
            && self.height > 0.0
            && self.width.is_finite()
            && self.height.is_finite())
        {
            return Err(LayoutError::BadDimensions(
                self.width.to_string(),
                self.height.to_string(),
            ));
        }

        let mut seen = std::collections::HashSet::new();
        // Props are allowed to share pixel ranges (e.g. mirrored strips), so
        // we only enforce uniqueness of prop ids and non-zero pixel counts.
        for prop in &self.props {
            if prop.pixel_count == 0 {
                return Err(LayoutError::ZeroPixelProp(prop.id.clone()));
            }
            if !seen.insert(prop.id.as_str()) {
                return Err(LayoutError::DuplicatePropId(prop.id.clone()));
            }
        }
        Ok(())
    }

    /// Total pixels referenced by props (max `pixel_end`). Useful for sizing
    /// the show engine's frame buffer to fit a layout.
    #[must_use]
    pub fn total_pixels(&self) -> usize {
        self.props.iter().map(Prop::pixel_end).max().unwrap_or(0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn strip(id: &str, offset: usize, count: usize) -> Prop {
        Prop {
            id: id.into(),
            name: id.into(),
            pixel_offset: offset,
            pixel_count: count,
            geometry: Geometry::Strip {
                start: Point { x: 0.0, y: 0.0 },
                end: Point { x: 100.0, y: 0.0 },
            },
        }
    }

    #[test]
    fn empty_layout_validates() {
        let l = Layout::empty("l1", "Living Room", 800.0, 600.0);
        l.validate().unwrap();
        assert_eq!(l.total_pixels(), 0);
    }

    #[test]
    fn rejects_bad_dimensions_and_dup_props() {
        let mut bad = Layout::empty("l1", "x", 0.0, 100.0);
        assert!(matches!(
            bad.validate(),
            Err(LayoutError::BadDimensions(_, _))
        ));

        bad = Layout::empty("l1", "x", 100.0, 100.0);
        bad.props.push(strip("a", 0, 10));
        bad.props.push(strip("a", 10, 10));
        assert_eq!(
            bad.validate().unwrap_err(),
            LayoutError::DuplicatePropId("a".into())
        );
    }

    #[test]
    fn allows_overlapping_pixel_ranges() {
        // Mirrored / shared pixel ranges across props are permitted by design.
        let mut l = Layout::empty("l1", "x", 100.0, 100.0);
        l.props.push(strip("a", 0, 30));
        l.props.push(strip("b", 20, 30));
        l.validate().unwrap();
    }

    #[test]
    fn total_pixels_uses_furthest_prop() {
        let mut l = Layout::empty("l1", "x", 100.0, 100.0);
        l.props.push(strip("a", 0, 30));
        l.props.push(strip("b", 30, 60));
        assert_eq!(l.total_pixels(), 90);
    }

    #[test]
    fn json_roundtrips() {
        let mut l = Layout::empty("l1", "Demo", 800.0, 600.0);
        l.props.push(strip("a", 0, 30));
        let json = serde_json::to_string(&l).unwrap();
        let back: Layout = serde_json::from_str(&json).unwrap();
        assert_eq!(l, back);
    }
}
