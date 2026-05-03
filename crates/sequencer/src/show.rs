//! Live, mutable show state shared between the engine and the REST API.
//!
//! The engine ticks against a [`SharedShow`] every frame. The show runs in one
//! of two modes:
//!
//! - [`PlaybackMode::Live`] — a single user-selected effect renders forever
//!   (Phase 1/2 behavior). REST handlers can swap effect/color/brightness in
//!   real time.
//! - [`PlaybackMode::Sequence`] — a saved [`Sequence`] of timed clips drives
//!   the active effect. The show resolves the active clip per tick, builds
//!   the appropriate effect on transitions, and emits black during gaps.
//!
//! Brightness and play/stop apply in both modes.

use std::sync::{Arc, Mutex};

use controller::Rgb;
use serde::{Deserialize, Serialize};

use crate::{
    Effect, EffectContext, Sequence,
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

/// Coarse playback mode reported to the UI.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PlaybackMode {
    Live,
    Sequence,
}

/// Snapshot of the sequence playhead. Returned by REST status calls so the
/// UI can render a live timeline cursor.
#[derive(Debug, Clone, Serialize)]
pub struct PlaybackInfo {
    pub mode: PlaybackMode,
    pub sequence_id: Option<String>,
    pub sequence_name: Option<String>,
    pub position_ms: u64,
    pub duration_ms: u64,
    pub looping: bool,
}

/// Internal sequence-mode bookkeeping.
struct SequencePlayback {
    seq: Sequence,
    looping: bool,
    /// `EffectContext::elapsed_secs` at the moment playback started.
    /// `f32::NAN` until the first tick primes it, so position_ms starts at 0.
    started_at_secs: f32,
    /// Index into `seq.clips` of the currently rendering clip, or `None`
    /// during a gap.
    active_clip_idx: Option<usize>,
    /// Effect built from the active clip; `None` during a gap.
    effect: Option<Box<dyn Effect>>,
    /// Cached `effective_duration_ms` so we don't recompute every tick.
    duration_ms: u64,
    /// Last computed playhead position (ms), exposed via [`PlaybackInfo`].
    last_position_ms: u64,
}

/// Live show state mutated by the REST API and read by the engine.
pub struct ShowState {
    playing: bool,
    brightness: f32,
    color: Rgb,
    kind: EffectKind,
    effect: Box<dyn Effect>,
    sequence: Option<SequencePlayback>,
}

impl ShowState {
    /// Build a new show in live mode, playing, full brightness, with the
    /// given effect/color.
    #[must_use]
    pub fn new(kind: EffectKind, color: Rgb) -> Self {
        Self {
            playing: true,
            brightness: 1.0,
            color,
            kind,
            effect: kind.build(color),
            sequence: None,
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

    /// Current playback mode.
    #[must_use]
    pub fn mode(&self) -> PlaybackMode {
        if self.sequence.is_some() {
            PlaybackMode::Sequence
        } else {
            PlaybackMode::Live
        }
    }

    /// Live playhead snapshot. `position_ms`/`duration_ms` are 0 in live mode.
    #[must_use]
    pub fn playback_info(&self) -> PlaybackInfo {
        match &self.sequence {
            Some(sp) => PlaybackInfo {
                mode: PlaybackMode::Sequence,
                sequence_id: Some(sp.seq.id.clone()),
                sequence_name: Some(sp.seq.name.clone()),
                position_ms: sp.last_position_ms,
                duration_ms: sp.duration_ms,
                looping: sp.looping,
            },
            None => PlaybackInfo {
                mode: PlaybackMode::Live,
                sequence_id: None,
                sequence_name: None,
                position_ms: 0,
                duration_ms: 0,
                looping: false,
            },
        }
    }

    pub fn set_playing(&mut self, playing: bool) {
        self.playing = playing;
    }

    /// Clamps to `[0.0, 1.0]`.
    pub fn set_brightness(&mut self, brightness: f32) {
        self.brightness = brightness.clamp(0.0, 1.0);
    }

    /// Updates the live show color and rebuilds the active effect so the
    /// change is visible immediately. No effect on sequence mode (clips own
    /// their own colors).
    pub fn set_color(&mut self, color: Rgb) {
        self.color = color;
        if self.sequence.is_none() && self.kind.uses_color() {
            self.effect = self.kind.build(color);
        }
    }

    /// Switch the live-mode effect kind. Drops sequence mode if active so the
    /// caller's intent ("show me effect X now") wins over any running show.
    pub fn set_kind(&mut self, kind: EffectKind) {
        let was_sequencing = self.sequence.is_some();
        self.sequence = None;
        if kind != self.kind || was_sequencing {
            self.kind = kind;
            self.effect = kind.build(self.color);
        }
    }

    /// Begin playing a sequence. The first frame after this call seeds the
    /// playback start time, so `position_ms` starts at exactly 0.
    pub fn play_sequence(&mut self, seq: Sequence, looping: bool) {
        let duration_ms = seq.effective_duration_ms();
        self.sequence = Some(SequencePlayback {
            seq,
            looping,
            started_at_secs: f32::NAN,
            active_clip_idx: None,
            effect: None,
            duration_ms,
            last_position_ms: 0,
        });
        self.playing = true;
    }

    /// Stop sequence playback and return to live mode.
    pub fn stop_sequence(&mut self) {
        if self.sequence.take().is_some() {
            // Re-build the live effect so the live preview is clean.
            self.effect = self.kind.build(self.color);
        }
    }

    /// Render one frame into `out`, honoring play/stop, mode, and brightness.
    pub fn tick(&mut self, ctx: EffectContext, out: &mut [Rgb]) {
        if !self.playing {
            for slot in out.iter_mut() {
                *slot = Rgb::BLACK;
            }
            return;
        }

        match &mut self.sequence {
            None => self.effect.tick(ctx, out),
            Some(sp) => tick_sequence(sp, ctx, out),
        }

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

fn tick_sequence(sp: &mut SequencePlayback, ctx: EffectContext, out: &mut [Rgb]) {
    if sp.started_at_secs.is_nan() {
        sp.started_at_secs = ctx.elapsed_secs;
    }

    let raw_secs = (ctx.elapsed_secs - sp.started_at_secs).max(0.0);
    let raw_ms = (raw_secs * 1000.0) as u64;

    let t_ms = if sp.looping && sp.duration_ms > 0 {
        raw_ms % sp.duration_ms
    } else if sp.duration_ms > 0 && raw_ms >= sp.duration_ms {
        // One-shot complete: park at the end and emit black.
        sp.last_position_ms = sp.duration_ms;
        sp.active_clip_idx = None;
        sp.effect = None;
        for slot in out.iter_mut() {
            *slot = Rgb::BLACK;
        }
        return;
    } else {
        raw_ms
    };
    sp.last_position_ms = t_ms;

    // Find the active clip; latest start_ms wins on overlaps (matches
    // `Sequence::clip_at`). We need the index here so we can rebuild the
    // boxed effect only on transitions.
    let active = sp
        .seq
        .clips
        .iter()
        .enumerate()
        .filter(|(_, c)| c.contains(t_ms))
        .max_by_key(|(_, c)| c.start_ms);

    match active {
        Some((idx, clip)) => {
            if sp.active_clip_idx != Some(idx) {
                sp.active_clip_idx = Some(idx);
                sp.effect = Some(clip.kind.build(clip.color.into()));
            }
            let clip_elapsed_secs =
                t_ms.saturating_sub(clip.start_ms) as f32 / 1000.0;
            let clip_ctx = EffectContext {
                pixel_count: ctx.pixel_count,
                frame: ctx.frame,
                elapsed_secs: clip_elapsed_secs,
            };
            if let Some(eff) = sp.effect.as_mut() {
                eff.tick(clip_ctx, out);
            }
        }
        None => {
            sp.active_clip_idx = None;
            sp.effect = None;
            for slot in out.iter_mut() {
                *slot = Rgb::BLACK;
            }
        }
    }
}

/// Shared, lockable show state.
pub type SharedShow = Arc<Mutex<ShowState>>;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{Clip, ClipColor};

    fn ctx(n: usize, elapsed_secs: f32) -> EffectContext {
        EffectContext {
            pixel_count: n,
            frame: (elapsed_secs * 60.0) as u64,
            elapsed_secs,
        }
    }

    #[test]
    fn stopped_show_emits_black() {
        let mut show = ShowState::new(EffectKind::Solid, Rgb(255, 0, 0));
        show.set_playing(false);
        let mut buf = vec![Rgb(9, 9, 9); 4];
        show.tick(ctx(4, 0.0), &mut buf);
        assert!(buf.iter().all(|p| *p == Rgb::BLACK));
    }

    #[test]
    fn brightness_scales_output() {
        let mut show = ShowState::new(EffectKind::Solid, Rgb(200, 100, 50));
        show.set_brightness(0.5);
        let mut buf = vec![Rgb::BLACK; 2];
        show.tick(ctx(2, 0.0), &mut buf);
        for p in &buf {
            assert_eq!(*p, Rgb(100, 50, 25));
        }
    }

    #[test]
    fn changing_color_takes_effect_immediately() {
        let mut show = ShowState::new(EffectKind::Solid, Rgb(10, 10, 10));
        show.set_color(Rgb(0, 200, 0));
        let mut buf = vec![Rgb::BLACK; 3];
        show.tick(ctx(3, 0.0), &mut buf);
        assert!(buf.iter().all(|p| *p == Rgb(0, 200, 0)));
    }

    #[test]
    fn switching_effect_uses_current_color() {
        let mut show = ShowState::new(EffectKind::Rainbow, Rgb(0, 200, 0));
        show.set_kind(EffectKind::Solid);
        let mut buf = vec![Rgb::BLACK; 2];
        show.tick(ctx(2, 0.0), &mut buf);
        assert!(buf.iter().all(|p| *p == Rgb(0, 200, 0)));
    }

    fn solid_clip(id: &str, start: u64, dur: u64, rgb: (u8, u8, u8)) -> Clip {
        Clip {
            id: id.into(),
            start_ms: start,
            duration_ms: dur,
            kind: EffectKind::Solid,
            color: ClipColor {
                r: rgb.0,
                g: rgb.1,
                b: rgb.2,
            },
        }
    }

    #[test]
    fn sequence_renders_active_clip_color() {
        let mut seq = Sequence::empty("s", "demo", 2_000);
        seq.clips.push(solid_clip("a", 0, 1_000, (10, 0, 0)));
        seq.clips.push(solid_clip("b", 1_000, 1_000, (0, 20, 0)));

        let mut show = ShowState::new(EffectKind::Rainbow, Rgb::BLACK);
        show.play_sequence(seq, false);

        let mut buf = vec![Rgb::BLACK; 2];
        show.tick(ctx(2, 0.0), &mut buf); // primes started_at, t=0 → clip a
        assert!(buf.iter().all(|p| *p == Rgb(10, 0, 0)));

        show.tick(ctx(2, 1.5), &mut buf); // t=1500 → clip b
        assert!(buf.iter().all(|p| *p == Rgb(0, 20, 0)));

        let info = show.playback_info();
        assert_eq!(info.mode, PlaybackMode::Sequence);
        assert_eq!(info.duration_ms, 2_000);
        assert!(info.position_ms >= 1_400);
    }

    #[test]
    fn sequence_gap_emits_black() {
        let mut seq = Sequence::empty("s", "demo", 3_000);
        seq.clips.push(solid_clip("a", 0, 1_000, (10, 0, 0)));
        seq.clips.push(solid_clip("b", 2_000, 1_000, (0, 20, 0)));

        let mut show = ShowState::new(EffectKind::Solid, Rgb(99, 99, 99));
        show.play_sequence(seq, false);
        let mut buf = vec![Rgb::BLACK; 2];
        show.tick(ctx(2, 0.0), &mut buf); // prime
        show.tick(ctx(2, 1.5), &mut buf); // gap
        assert!(buf.iter().all(|p| *p == Rgb::BLACK));
    }

    #[test]
    fn sequence_one_shot_finishes_to_black() {
        let mut seq = Sequence::empty("s", "demo", 500);
        seq.clips.push(solid_clip("a", 0, 500, (10, 0, 0)));

        let mut show = ShowState::new(EffectKind::Solid, Rgb(1, 1, 1));
        show.play_sequence(seq, false);
        let mut buf = vec![Rgb::BLACK; 2];
        show.tick(ctx(2, 0.0), &mut buf);
        show.tick(ctx(2, 1.0), &mut buf);
        assert!(buf.iter().all(|p| *p == Rgb::BLACK));
        assert_eq!(show.playback_info().position_ms, 500);
    }

    #[test]
    fn sequence_loops_back_to_first_clip() {
        let mut seq = Sequence::empty("s", "demo", 1_000);
        seq.clips.push(solid_clip("a", 0, 500, (10, 0, 0)));
        seq.clips.push(solid_clip("b", 500, 500, (0, 20, 0)));

        let mut show = ShowState::new(EffectKind::Solid, Rgb::BLACK);
        show.play_sequence(seq, true);
        let mut buf = vec![Rgb::BLACK; 2];
        show.tick(ctx(2, 0.0), &mut buf); // t=0 → clip a
        assert_eq!(buf[0], Rgb(10, 0, 0));

        show.tick(ctx(2, 1.1), &mut buf); // wraps to t=100 → clip a again
        assert_eq!(buf[0], Rgb(10, 0, 0));
    }

    #[test]
    fn stop_sequence_returns_to_live() {
        let mut seq = Sequence::empty("s", "demo", 1_000);
        seq.clips.push(solid_clip("a", 0, 1_000, (10, 0, 0)));

        let mut show = ShowState::new(EffectKind::Solid, Rgb(99, 99, 99));
        show.play_sequence(seq, true);
        show.stop_sequence();
        assert_eq!(show.mode(), PlaybackMode::Live);

        let mut buf = vec![Rgb::BLACK; 2];
        show.tick(ctx(2, 0.0), &mut buf);
        assert!(buf.iter().all(|p| *p == Rgb(99, 99, 99)));
    }
}
