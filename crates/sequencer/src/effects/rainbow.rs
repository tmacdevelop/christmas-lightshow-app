//! Hue-cycling rainbow sweep across the strip.

use controller::Rgb;

use crate::{Effect, EffectContext, color::hsv_to_rgb};

/// A rainbow effect that scrolls a full hue rotation across the strip.
#[derive(Debug, Clone, Copy)]
pub struct Rainbow {
    /// Full hue rotations per second (e.g. `0.2` = one rotation every 5s).
    pub speed_hz: f32,
    /// Saturation in `[0, 1]`.
    pub saturation: f32,
    /// Value (brightness) in `[0, 1]`.
    pub value: f32,
}

impl Default for Rainbow {
    fn default() -> Self {
        Self {
            speed_hz: 0.2,
            saturation: 1.0,
            value: 1.0,
        }
    }
}

impl Effect for Rainbow {
    fn name(&self) -> &'static str {
        "rainbow"
    }

    fn tick(&mut self, ctx: EffectContext, out: &mut [Rgb]) {
        debug_assert_eq!(out.len(), ctx.pixel_count);
        if ctx.pixel_count == 0 {
            return;
        }

        let phase = ctx.elapsed_secs * self.speed_hz;
        let span = ctx.pixel_count as f32;

        for (i, slot) in out.iter_mut().enumerate() {
            let hue = (i as f32 / span) + phase;
            *slot = hsv_to_rgb(hue, self.saturation, self.value);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fills_every_pixel() {
        let mut effect = Rainbow::default();
        let mut buf = vec![Rgb::BLACK; 16];
        effect.tick(
            EffectContext {
                pixel_count: 16,
                frame: 0,
                elapsed_secs: 0.0,
            },
            &mut buf,
        );

        // At t=0, the first pixel should be pure red.
        assert_eq!(buf[0], Rgb(255, 0, 0));
        // No pixel should be left as the initial black.
        assert!(buf.iter().any(|p| *p != Rgb::BLACK));
    }

    #[test]
    fn empty_strip_is_a_noop() {
        let mut effect = Rainbow::default();
        let mut buf: Vec<Rgb> = Vec::new();
        effect.tick(
            EffectContext {
                pixel_count: 0,
                frame: 0,
                elapsed_secs: 1.5,
            },
            &mut buf,
        );
        assert!(buf.is_empty());
    }
}
