//! Fixed-rate frame engine that drives a [`ShowState`] into a [`Renderer`].

use std::time::{Duration, Instant};

use controller::{Renderer, Rgb};
use tokio::time::{MissedTickBehavior, interval};

use crate::{EffectContext, SharedShow};

/// Drives the live [`crate::ShowState`] at a fixed frame rate.
pub struct Engine<R: Renderer> {
    renderer: R,
    show: SharedShow,
    fps: u32,
    buffer: Vec<Rgb>,
}

impl<R: Renderer> Engine<R> {
    /// Build an engine. `fps` must be > 0.
    ///
    /// # Panics
    ///
    /// Panics if `fps` is 0.
    pub fn new(renderer: R, show: SharedShow, fps: u32) -> Self {
        assert!(fps > 0, "fps must be > 0");
        let pixel_count = renderer.pixel_count();
        Self {
            renderer,
            show,
            fps,
            buffer: vec![Rgb::BLACK; pixel_count],
        }
    }

    /// Run the engine forever, ticking at the configured FPS.
    ///
    /// The future never returns under normal operation; cancel it by dropping
    /// the task handle.
    pub async fn run(mut self) {
        let period = Duration::from_secs_f64(1.0 / f64::from(self.fps));
        let mut ticker = interval(period);
        ticker.set_missed_tick_behavior(MissedTickBehavior::Skip);

        let started = Instant::now();
        let mut frame: u64 = 0;
        let pixel_count = self.renderer.pixel_count();

        tracing::info!(fps = self.fps, pixel_count, "engine started");

        loop {
            ticker.tick().await;
            let elapsed_secs = started.elapsed().as_secs_f32();

            {
                let mut show = match self.show.lock() {
                    Ok(guard) => guard,
                    Err(poisoned) => poisoned.into_inner(),
                };
                show.tick(
                    EffectContext {
                        pixel_count,
                        frame,
                        elapsed_secs,
                    },
                    &mut self.buffer,
                );
            }

            if let Err(err) = self.renderer.render(&self.buffer) {
                tracing::error!(?err, "renderer rejected frame");
            }
            frame = frame.wrapping_add(1);
        }
    }
}

