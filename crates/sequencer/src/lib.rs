//! Show playback engine: effects, timeline, frame scheduling.
//!
//! Phase 1 ships:
//! - [`Effect`] trait + [`EffectContext`] passed to each tick.
//! - [`effects::Solid`], [`effects::Fade`], [`effects::Chase`], and
//!   [`effects::Rainbow`].
//! - [`Engine`] — drives an effect at a fixed FPS into a [`Renderer`].

pub mod color;
pub mod effects;
mod engine;
mod show;

pub use engine::Engine;
pub use show::{EffectKind, SharedShow, ShowState};

use controller::Rgb;

/// Per-tick context handed to an [`Effect`].
#[derive(Debug, Clone, Copy)]
pub struct EffectContext {
    /// Pixels in the strip being rendered.
    pub pixel_count: usize,
    /// Frame number since the engine started (monotonic, never resets).
    pub frame: u64,
    /// Seconds elapsed since the engine started.
    pub elapsed_secs: f32,
}

/// A pure function from `(EffectContext, &mut frame buffer)` to a written frame.
///
/// Effects must be `Send` so the engine can run on a background task.
pub trait Effect: Send {
    /// Human-readable name (used for logging / future REST API).
    fn name(&self) -> &'static str;

    /// Render one frame into `out`. The engine guarantees
    /// `out.len() == ctx.pixel_count`.
    fn tick(&mut self, ctx: EffectContext, out: &mut [Rgb]);
}
