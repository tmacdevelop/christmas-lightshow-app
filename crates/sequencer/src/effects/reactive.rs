//! Beat-reactive effect driven by external pulse events (e.g. browser
//! microphone-based onset detection). The effect maintains a decaying
//! pulse intensity and rotates through a small color palette so each
//! pulse pops in a different hue.
//!
//! `Reactive` is a "live" effect: there is no timeline. The REST API
//! pushes pulses via [`Reactive::pulse`] and the engine reads the
//! intensity each tick.

use std::sync::{Arc, Mutex};
use std::time::Instant;

use controller::Rgb;

use crate::{Effect, EffectContext};

/// Cheap-to-clone handle to a reactive effect's pulse state. The API holds
/// one; the engine holds another. Pushing a pulse just updates the shared
/// state.
#[derive(Clone, Debug, Default)]
pub struct ReactiveHandle {
    inner: Arc<Mutex<ReactiveInner>>,
}

#[derive(Debug)]
struct ReactiveInner {
    /// Intensity of the most recent pulse, in `[0.0, 1.0]`.
    pulse_intensity: f32,
    /// Color of the most recent pulse.
    pulse_color: Rgb,
    /// Wall-clock time the most recent pulse arrived.
    pulse_at: Instant,
    /// Counter used to rotate through the palette when no color is given.
    palette_idx: u32,
}

impl Default for ReactiveInner {
    fn default() -> Self {
        Self {
            pulse_intensity: 0.0,
            pulse_color: Rgb::BLACK,
            // Park far in the past so the initial render is fully decayed.
            pulse_at: Instant::now() - std::time::Duration::from_secs(60),
            palette_idx: 0,
        }
    }
}

/// Christmas-themed palette used when callers don't supply a color.
const PALETTE: &[Rgb] = &[
    Rgb(255, 30, 30),   // red
    Rgb(0, 220, 60),    // green
    Rgb(255, 220, 80),  // gold
    Rgb(255, 255, 255), // white
    Rgb(0, 120, 255),   // ice blue
];

impl ReactiveHandle {
    /// Record a new pulse. `intensity` is clamped to `[0, 1]`. If `color`
    /// is `None`, the next entry in the rotating palette is used.
    pub fn pulse(&self, intensity: f32, color: Option<Rgb>) {
        let mut g = match self.inner.lock() {
            Ok(g) => g,
            Err(p) => p.into_inner(),
        };
        let chosen = color.unwrap_or_else(|| {
            let c = PALETTE[(g.palette_idx as usize) % PALETTE.len()];
            g.palette_idx = g.palette_idx.wrapping_add(1);
            c
        });
        g.pulse_intensity = intensity.clamp(0.0, 1.0);
        g.pulse_color = chosen;
        g.pulse_at = Instant::now();
    }
}

/// `Effect` implementation that renders the most recent pulse with
/// exponential decay (≈300 ms half-life).
#[derive(Debug, Clone)]
pub struct Reactive {
    handle: ReactiveHandle,
    /// Minimum brightness floor so the strip isn't fully dark between
    /// beats. `0.0` = pitch black between pulses; default is a soft glow.
    pub baseline: f32,
    /// Color used for the baseline glow.
    pub baseline_color: Rgb,
    /// Decay constant (1/seconds). Larger = faster fade.
    pub decay_per_sec: f32,
}

impl Default for Reactive {
    fn default() -> Self {
        Self {
            handle: ReactiveHandle::default(),
            baseline: 0.05,
            baseline_color: Rgb(20, 6, 0),
            decay_per_sec: 4.0,
        }
    }
}

impl Reactive {
    /// Build a new effect that shares the given pulse handle.
    #[must_use]
    pub fn with_handle(handle: ReactiveHandle) -> Self {
        Self {
            handle,
            ..Self::default()
        }
    }

    #[must_use]
    pub fn handle(&self) -> ReactiveHandle {
        self.handle.clone()
    }
}

impl Effect for Reactive {
    fn name(&self) -> &'static str {
        "reactive"
    }

    fn tick(&mut self, ctx: EffectContext, out: &mut [Rgb]) {
        debug_assert_eq!(out.len(), ctx.pixel_count);
        let (intensity, color, age_secs) = {
            let g = match self.handle.inner.lock() {
                Ok(g) => g,
                Err(p) => p.into_inner(),
            };
            (
                g.pulse_intensity,
                g.pulse_color,
                g.pulse_at.elapsed().as_secs_f32(),
            )
        };

        let decay = (-age_secs * self.decay_per_sec).exp();
        let live = (intensity * decay).clamp(0.0, 1.0);
        let base_w = 1.0 - live;

        let pr = blend_channel(self.baseline_color.0, color.0, live, base_w);
        let pg = blend_channel(self.baseline_color.1, color.1, live, base_w);
        let pb = blend_channel(self.baseline_color.2, color.2, live, base_w);
        let frame = Rgb(pr, pg, pb);
        for slot in out.iter_mut() {
            *slot = frame;
        }
    }
}

/// Blend two channels: `base * base_w + pulse * pulse_w`, clamped to u8.
fn blend_channel(base: u8, pulse: u8, pulse_w: f32, base_w: f32) -> u8 {
    let v = f32::from(base) * base_w + f32::from(pulse) * pulse_w;
    v.round().clamp(0.0, 255.0) as u8
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pulse_starts_bright_and_decays() {
        let mut effect = Reactive::default();
        let handle = effect.handle();
        handle.pulse(1.0, Some(Rgb(255, 255, 255)));
        let mut buf = vec![Rgb::BLACK; 4];
        effect.tick(
            EffectContext {
                pixel_count: 4,
                frame: 0,
                elapsed_secs: 0.0,
            },
            &mut buf,
        );
        // Immediately after a pulse the strip should be near full-bright.
        assert!(buf.iter().all(|p| p.0 > 200));
    }

    #[test]
    fn no_pulse_renders_baseline() {
        let mut effect = Reactive::default();
        let mut buf = vec![Rgb::BLACK; 2];
        effect.tick(
            EffectContext {
                pixel_count: 2,
                frame: 0,
                elapsed_secs: 0.0,
            },
            &mut buf,
        );
        // Should be baseline color, not black.
        assert_eq!(buf[0], effect.baseline_color);
    }
}
