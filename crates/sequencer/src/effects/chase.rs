//! A block of `width` pixels chasing along the strip.

use controller::Rgb;

use crate::{Effect, EffectContext};

/// Moves a bright "comet" of `width` pixels across a dark background.
#[derive(Debug, Clone, Copy)]
pub struct Chase {
    /// Color of the moving block.
    pub color: Rgb,
    /// Full strip traversals per second.
    pub speed_hz: f32,
    /// Number of lit pixels per block.
    pub width: usize,
}

impl Default for Chase {
    fn default() -> Self {
        Self {
            color: Rgb(255, 255, 255),
            speed_hz: 0.5,
            width: 4,
        }
    }
}

impl Chase {
    #[must_use]
    pub fn new(color: Rgb, speed_hz: f32, width: usize) -> Self {
        Self {
            color,
            speed_hz,
            width,
        }
    }
}

impl Effect for Chase {
    fn name(&self) -> &'static str {
        "chase"
    }

    fn tick(&mut self, ctx: EffectContext, out: &mut [Rgb]) {
        debug_assert_eq!(out.len(), ctx.pixel_count);
        if ctx.pixel_count == 0 {
            return;
        }

        // Clear background.
        for slot in out.iter_mut() {
            *slot = Rgb::BLACK;
        }

        let n = ctx.pixel_count;
        let width = self.width.max(1).min(n);

        // Head position wraps around the strip once per `1 / speed_hz` seconds.
        let phase = (ctx.elapsed_secs * self.speed_hz).rem_euclid(1.0);
        let head = (phase * n as f32) as usize % n;

        for i in 0..width {
            let idx = (head + i) % n;
            // Linear taper from bright head to dim tail for a comet-y look.
            let level = 1.0 - (i as f32 / width as f32);
            let r = (self.color.0 as f32 * level).round() as u8;
            let g = (self.color.1 as f32 * level).round() as u8;
            let b = (self.color.2 as f32 * level).round() as u8;
            out[idx] = Rgb(r, g, b);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lights_only_the_block() {
        let mut effect = Chase::new(Rgb(255, 255, 255), 0.0, 3);
        let mut buf = vec![Rgb(9, 9, 9); 10];
        effect.tick(
            EffectContext {
                pixel_count: 10,
                frame: 0,
                elapsed_secs: 0.0,
            },
            &mut buf,
        );
        // Head is at index 0 because elapsed_secs=0.
        assert_eq!(buf[0], Rgb(255, 255, 255));
        // The rest of the block is lit but dimmer; pixels past the block are black.
        assert_ne!(buf[1], Rgb::BLACK);
        assert_ne!(buf[2], Rgb::BLACK);
        for &p in &buf[3..] {
            assert_eq!(p, Rgb::BLACK);
        }
    }

    #[test]
    fn empty_strip_is_a_noop() {
        let mut effect = Chase::default();
        let mut buf: Vec<Rgb> = Vec::new();
        effect.tick(
            EffectContext {
                pixel_count: 0,
                frame: 0,
                elapsed_secs: 1.0,
            },
            &mut buf,
        );
        assert!(buf.is_empty());
    }
}
