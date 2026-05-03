//! Hardware drivers and the [`Renderer`] trait.
//!
//! Phase 1 ships [`VirtualRenderer`], which fans frames out to subscribed
//! WebSocket clients. Phase 4.5+ will add hardware renderers (`Ws2812Renderer`,
//! `SacnRenderer`).

mod virtual_renderer;

pub use virtual_renderer::{FrameSubscriber, VirtualRenderer};

use serde::{Deserialize, Serialize};

/// A single pixel as packed 8-bit RGB.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct Rgb(pub u8, pub u8, pub u8);

impl Rgb {
    pub const BLACK: Rgb = Rgb(0, 0, 0);

    #[inline]
    #[must_use]
    pub const fn new(r: u8, g: u8, b: u8) -> Self {
        Self(r, g, b)
    }
}

/// Errors that a renderer can return.
#[derive(Debug, thiserror::Error)]
pub enum RenderError {
    #[error("frame size {actual} does not match pixel count {expected}")]
    FrameSizeMismatch { expected: usize, actual: usize },
}

/// Anything that can accept a fully-rendered frame of pixels.
///
/// Phase 1 has a single implementation, [`VirtualRenderer`], that broadcasts
/// frames to WebSocket clients. The same trait will be implemented by
/// hardware-backed renderers in later phases.
pub trait Renderer: Send {
    /// Number of pixels this renderer expects per frame.
    fn pixel_count(&self) -> usize;

    /// Push a frame to the renderer.
    ///
    /// Implementations must return [`RenderError::FrameSizeMismatch`] if
    /// `frame.len() != self.pixel_count()`.
    fn render(&mut self, frame: &[Rgb]) -> Result<(), RenderError>;
}
