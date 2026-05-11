//! Convert a Spotify [`AudioAnalysis`] (plus [`Track`] metadata) into our
//! own [`sequencer::Sequence`].
//!
//! Strategy:
//! - Walk `analysis.sections` to pick a color palette per section using the
//!   musical key + mode (major → warm, minor → cool).
//! - For each beat that falls inside a section, emit a `Clip` whose duration
//!   is the gap to the next beat (or the section end for the last beat).
//! - Effect kind is picked from beat confidence and section energy so heavy
//!   downbeats flash `Solid`, lighter passages get `Fade`/`Chase`, and high-
//!   energy bridges punch `Rainbow`.
//!
//! This is intentionally a "v1" mapping — good enough to look pleasant on a
//! virtual strip; later phases will plug in segment-level pitch/timbre data.

use sequencer::{Clip, ClipColor, EffectKind, Sequence};

use crate::{analysis::AudioAnalysis, api::Track};

/// Build a `Sequence` from Spotify analysis. The id is the Spotify track id
/// prefixed with `spotify-` so it can't collide with user-saved sequences.
pub fn build_sequence(analysis: &AudioAnalysis, track: &Track) -> Sequence {
    let duration_ms = if track.duration_ms > 0 {
        track.duration_ms
    } else {
        (analysis.track.duration * 1000.0) as u64
    };

    let name = sequence_name(track);
    let id = format!("spotify-{}", track.id);

    let mut seq = Sequence::empty(id, name, duration_ms);

    if analysis.beats.is_empty() {
        return seq;
    }

    // Sort beats once; Spotify already returns them in order, but be safe.
    let mut beats: Vec<&crate::analysis::TimeInterval> = analysis.beats.iter().collect();
    beats.sort_by(|a, b| {
        a.start
            .partial_cmp(&b.start)
            .unwrap_or(std::cmp::Ordering::Equal)
    });

    // Default section if Spotify gave us none.
    let default_section = crate::analysis::Section {
        start: 0.0,
        duration: (duration_ms as f32) / 1000.0,
        ..Default::default()
    };
    let sections: Vec<&crate::analysis::Section> = if analysis.sections.is_empty() {
        vec![&default_section]
    } else {
        analysis.sections.iter().collect()
    };

    let mut clip_idx: u64 = 0;
    for (sec_i, section) in sections.iter().enumerate() {
        let palette = palette_for(section.key, section.mode);
        let energy = section_energy(section);

        let sec_start = section.start;
        let sec_end = section.start + section.duration;
        let beats_here: Vec<&crate::analysis::TimeInterval> = beats
            .iter()
            .copied()
            .filter(|b| b.start >= sec_start && b.start < sec_end)
            .collect();

        for (i, beat) in beats_here.iter().enumerate() {
            let next = beats_here.get(i + 1).map(|b| b.start).unwrap_or(sec_end);
            let dur_secs = (next - beat.start).max(0.05);
            let start_ms = (beat.start * 1000.0).round() as u64;
            let duration_ms = (dur_secs * 1000.0).round() as u64;
            let color = palette[(clip_idx as usize) % palette.len()];
            let kind = pick_effect(beat.confidence, energy, sec_i, i);
            seq.clips.push(Clip {
                id: format!("c{:06}", clip_idx),
                start_ms,
                duration_ms,
                kind,
                color: ClipColor {
                    r: color.0,
                    g: color.1,
                    b: color.2,
                },
                pattern: None,
            });
            clip_idx += 1;
        }
    }

    // Sort by start in case sections overlapped.
    seq.clips.sort_by_key(|c| c.start_ms);
    seq
}

fn sequence_name(track: &Track) -> String {
    let artists = track
        .artists
        .iter()
        .map(|a| a.name.as_str())
        .collect::<Vec<_>>()
        .join(", ");
    if artists.is_empty() {
        track.name.clone()
    } else {
        format!("{} — {}", artists, track.name)
    }
}

fn pick_effect(
    beat_confidence: f32,
    section_energy: f32,
    sec_i: usize,
    beat_i: usize,
) -> EffectKind {
    if section_energy > 0.75 && beat_i.is_multiple_of(4) {
        EffectKind::Rainbow
    } else if beat_confidence > 0.7 {
        EffectKind::Solid
    } else if (sec_i + beat_i).is_multiple_of(3) {
        EffectKind::Chase
    } else {
        EffectKind::Fade
    }
}

/// Crude proxy for "how loud / driving" this section is, in [0, 1].
fn section_energy(section: &crate::analysis::Section) -> f32 {
    // Spotify's `loudness` is in dB, typically -60..0. Map -30..0 -> 0..1.
    let l = section.loudness;
    ((l + 30.0) / 30.0).clamp(0.0, 1.0)
}

type Color = (u8, u8, u8);

/// Pick a small palette for this section based on key/mode.
///
/// Major keys lean warm (red/orange/gold/white), minor keys lean cool
/// (blue/teal/violet/cyan). Key value rotates the palette so adjacent keys
/// look related but distinct.
fn palette_for(key: i32, mode: i32) -> &'static [Color; 6] {
    const WARM: [[Color; 6]; 4] = [
        [
            (255, 30, 30),
            (255, 90, 0),
            (255, 200, 0),
            (255, 255, 255),
            (255, 60, 100),
            (255, 140, 0),
        ],
        [
            (255, 0, 60),
            (255, 130, 30),
            (255, 220, 50),
            (255, 255, 200),
            (255, 90, 0),
            (220, 50, 50),
        ],
        [
            (255, 60, 0),
            (255, 180, 0),
            (255, 90, 90),
            (255, 255, 130),
            (200, 30, 30),
            (255, 130, 30),
        ],
        [
            (255, 90, 90),
            (255, 50, 0),
            (255, 220, 100),
            (255, 255, 255),
            (220, 0, 0),
            (255, 160, 0),
        ],
    ];
    const COOL: [[Color; 6]; 4] = [
        [
            (0, 60, 255),
            (0, 200, 200),
            (90, 0, 200),
            (200, 220, 255),
            (0, 120, 255),
            (60, 0, 200),
        ],
        [
            (0, 30, 220),
            (0, 180, 255),
            (130, 30, 220),
            (180, 220, 255),
            (0, 90, 200),
            (90, 30, 200),
        ],
        [
            (30, 0, 255),
            (0, 220, 220),
            (200, 0, 255),
            (200, 230, 255),
            (30, 60, 220),
            (130, 0, 220),
        ],
        [
            (0, 90, 220),
            (0, 150, 255),
            (160, 30, 255),
            (220, 230, 255),
            (0, 60, 200),
            (90, 0, 180),
        ],
    ];
    let idx = (key.max(0) as usize) % 4;
    if mode == 1 { &WARM[idx] } else { &COOL[idx] }
}
