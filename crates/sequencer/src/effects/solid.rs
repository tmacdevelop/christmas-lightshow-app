//! Constant solid color across the strip.

use controller::Rgb;

use crate::{Effect, EffectContext};

/// Fills every pixel with a single color.
#[derive(Debug, Clone, Copy)]
pub struct Solid {
    /// Color written to every pixel.
    pub color: Rgb,
}

impl Default for Solid {
    fn default() -> Self {
        // Warm Christmas red.
        Self {
            color: Rgb(255, 0, 0),
        }
    }
}

impl Solid {
    #[must_use]
    pub fn new(color: Rgb) -> Self {
        Self { color }
    }
}

impl Effect for Solid {
    fn name(&self) -> &'static str {
        "solid"
    }

    fn tick(&mut self, ctx: EffectContext, out: &mut [Rgb]) {
        debug_assert_eq!(out.len(), ctx.pixel_count);
        for slot in out.iter_mut() {
            *slot = self.color;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fills_every_pixel_with_the_color() {
        let mut effect = Solid::new(Rgb(10, 20, 30));
        let mut buf = vec![Rgb::BLACK; 8];
        effect.tick(
            EffectContext {
                pixel_count: 8,
                frame: 0,
                elapsed_secs: 0.0,
            },
            &mut buf,
        );
        assert!(buf.iter().all(|p| *p == Rgb(10, 20, 30)));
    }

    #[test]
    fn empty_strip_is_a_noop() {
        let mut effect = Solid::default();
        let mut buf: Vec<Rgb> = Vec::new();
        effect.tick(
            EffectContext {
                pixel_count: 0,
                frame: 0,
                elapsed_secs: 0.0,
            },
            &mut buf,
        );
        assert!(buf.is_empty());
    }
}
