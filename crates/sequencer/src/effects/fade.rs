//! Smooth brightness fade (breathing) of a single color.

use controller::Rgb;

use crate::{Effect, EffectContext};

/// Pulses `color` between black and full brightness using a cosine envelope.
#[derive(Debug, Clone, Copy)]
pub struct Fade {
    /// Base color at peak brightness.
    pub color: Rgb,
    /// Full fade cycles per second (one cycle = dark → bright → dark).
    pub period_hz: f32,
}

impl Default for Fade {
    fn default() -> Self {
        Self {
            // Pleasant Christmas green.
            color: Rgb(0, 200, 60),
            period_hz: 0.5,
        }
    }
}

impl Fade {
    #[must_use]
    pub fn new(color: Rgb, period_hz: f32) -> Self {
        Self { color, period_hz }
    }
}

impl Effect for Fade {
    fn name(&self) -> &'static str {
        "fade"
    }

    fn tick(&mut self, ctx: EffectContext, out: &mut [Rgb]) {
        debug_assert_eq!(out.len(), ctx.pixel_count);
        // (1 - cos) / 2 → smooth 0..1..0 envelope.
        let phase = ctx.elapsed_secs * self.period_hz * std::f32::consts::TAU;
        let level = (1.0 - phase.cos()) * 0.5;
        let level = level.clamp(0.0, 1.0);

        let r = (self.color.0 as f32 * level).round() as u8;
        let g = (self.color.1 as f32 * level).round() as u8;
        let b = (self.color.2 as f32 * level).round() as u8;
        let scaled = Rgb(r, g, b);

        for slot in out.iter_mut() {
            *slot = scaled;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn starts_at_black() {
        let mut effect = Fade::new(Rgb(255, 255, 255), 1.0);
        let mut buf = vec![Rgb(99, 99, 99); 4];
        effect.tick(
            EffectContext {
                pixel_count: 4,
                frame: 0,
                elapsed_secs: 0.0,
            },
            &mut buf,
        );
        assert!(buf.iter().all(|p| *p == Rgb::BLACK));
    }

    #[test]
    fn peaks_at_half_period() {
        // period_hz=1.0 → full cycle in 1s, peak at t=0.5s.
        let mut effect = Fade::new(Rgb(200, 100, 50), 1.0);
        let mut buf = vec![Rgb::BLACK; 2];
        effect.tick(
            EffectContext {
                pixel_count: 2,
                frame: 30,
                elapsed_secs: 0.5,
            },
            &mut buf,
        );
        assert!(buf.iter().all(|p| *p == Rgb(200, 100, 50)));
    }
}
