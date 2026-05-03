//! Live, mutable show state shared between the engine and the REST API.
//!
//! The engine ticks against a [`SharedShow`] every frame: it reads the current
//! [`EffectKind`], lets the boxed effect render, then applies a global
//! brightness pass. REST handlers mutate the same [`ShowState`] to change
//! effect, color, brightness, or play/stop in real time.

use std::sync::{Arc, Mutex};

use controller::Rgb;
use serde::{Deserialize, Serialize};

use crate::{
    Effect, EffectContext,
    effects::{Chase, Fade, Rainbow, Solid},
};

/// All built-in effects exposed to the API.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum EffectKind {
    Solid,
    Fade,
    Chase,
    #[default]
    Rainbow,
}

impl EffectKind {
    /// All variants in display order.
    pub const ALL: &'static [EffectKind] = &[
        EffectKind::Solid,
        EffectKind::Fade,
        EffectKind::Chase,
        EffectKind::Rainbow,
    ];

    /// Lowercase identifier used on the wire.
    #[must_use]
    pub fn name(self) -> &'static str {
        match self {
            EffectKind::Solid => "solid",
            EffectKind::Fade => "fade",
            EffectKind::Chase => "chase",
            EffectKind::Rainbow => "rainbow",
        }
    }

    /// Whether this effect honors the show-wide color setting.
    #[must_use]
    pub fn uses_color(self) -> bool {
        !matches!(self, EffectKind::Rainbow)
    }

    /// Build a fresh boxed effect for this kind, seeded with `color` where
    /// applicable.
    #[must_use]
    pub fn build(self, color: Rgb) -> Box<dyn Effect> {
        match self {
            EffectKind::Solid => Box::new(Solid::new(color)),
            EffectKind::Fade => {
                let defaults = Fade::default();
                Box::new(Fade::new(color, defaults.period_hz))
            }
            EffectKind::Chase => {
                let defaults = Chase::default();
                Box::new(Chase::new(color, defaults.speed_hz, defaults.width))
            }
            EffectKind::Rainbow => Box::new(Rainbow::default()),
        }
    }
}

/// Live show state mutated by the REST API and read by the engine.
pub struct ShowState {
    playing: bool,
    brightness: f32,
    color: Rgb,
    kind: EffectKind,
    effect: Box<dyn Effect>,
}

impl ShowState {
    /// Build a new show, playing, full brightness, with the given effect/color.
    #[must_use]
    pub fn new(kind: EffectKind, color: Rgb) -> Self {
        Self {
            playing: true,
            brightness: 1.0,
            color,
            kind,
            effect: kind.build(color),
        }
    }

    /// Wrap in `Arc<Mutex<_>>` for sharing with the engine and API handlers.
    #[must_use]
    pub fn shared(self) -> SharedShow {
        Arc::new(Mutex::new(self))
    }

    #[must_use]
    pub fn playing(&self) -> bool {
        self.playing
    }

    #[must_use]
    pub fn brightness(&self) -> f32 {
        self.brightness
    }

    #[must_use]
    pub fn color(&self) -> Rgb {
        self.color
    }

    #[must_use]
    pub fn kind(&self) -> EffectKind {
        self.kind
    }

    pub fn set_playing(&mut self, playing: bool) {
        self.playing = playing;
    }

    /// Clamps to `[0.0, 1.0]`.
    pub fn set_brightness(&mut self, brightness: f32) {
        self.brightness = brightness.clamp(0.0, 1.0);
    }

    /// Updates the show color and rebuilds the active effect so the change is
    /// visible immediately (for color-aware effects).
    pub fn set_color(&mut self, color: Rgb) {
        self.color = color;
        if self.kind.uses_color() {
            self.effect = self.kind.build(color);
        }
    }

    /// Switch to a different effect kind. No-op if the kind is unchanged.
    pub fn set_kind(&mut self, kind: EffectKind) {
        if kind != self.kind {
            self.kind = kind;
            self.effect = kind.build(self.color);
        }
    }

    /// Render one frame into `out`, honoring play/stop and brightness.
    pub fn tick(&mut self, ctx: EffectContext, out: &mut [Rgb]) {
        if !self.playing {
            for slot in out.iter_mut() {
                *slot = Rgb::BLACK;
            }
            return;
        }

        self.effect.tick(ctx, out);

        if self.brightness < 1.0 {
            let b = self.brightness;
            for px in out.iter_mut() {
                px.0 = (f32::from(px.0) * b).round() as u8;
                px.1 = (f32::from(px.1) * b).round() as u8;
                px.2 = (f32::from(px.2) * b).round() as u8;
            }
        }
    }
}

/// Shared, lockable show state.
pub type SharedShow = Arc<Mutex<ShowState>>;

#[cfg(test)]
mod tests {
    use super::*;

    fn ctx(n: usize) -> EffectContext {
        EffectContext {
            pixel_count: n,
            frame: 0,
            elapsed_secs: 0.0,
        }
    }

    #[test]
    fn stopped_show_emits_black() {
        let mut show = ShowState::new(EffectKind::Solid, Rgb(255, 0, 0));
        show.set_playing(false);
        let mut buf = vec![Rgb(9, 9, 9); 4];
        show.tick(ctx(4), &mut buf);
        assert!(buf.iter().all(|p| *p == Rgb::BLACK));
    }

    #[test]
    fn brightness_scales_output() {
        let mut show = ShowState::new(EffectKind::Solid, Rgb(200, 100, 50));
        show.set_brightness(0.5);
        let mut buf = vec![Rgb::BLACK; 2];
        show.tick(ctx(2), &mut buf);
        for p in &buf {
            assert_eq!(*p, Rgb(100, 50, 25));
        }
    }

    #[test]
    fn changing_color_takes_effect_immediately() {
        let mut show = ShowState::new(EffectKind::Solid, Rgb(10, 10, 10));
        show.set_color(Rgb(0, 200, 0));
        let mut buf = vec![Rgb::BLACK; 3];
        show.tick(ctx(3), &mut buf);
        assert!(buf.iter().all(|p| *p == Rgb(0, 200, 0)));
    }

    #[test]
    fn switching_effect_uses_current_color() {
        let mut show = ShowState::new(EffectKind::Rainbow, Rgb(0, 200, 0));
        show.set_kind(EffectKind::Solid);
        let mut buf = vec![Rgb::BLACK; 2];
        show.tick(ctx(2), &mut buf);
        assert!(buf.iter().all(|p| *p == Rgb(0, 200, 0)));
    }
}
