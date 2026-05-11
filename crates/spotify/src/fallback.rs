//! Audio-analysis fallback for tracks where Spotify's `/v1/audio-analysis`
//! endpoint is unavailable (deprecated for apps registered after Nov 2024).
//!
//! Strategy: look the track up on Deezer by ISRC, fetch its `bpm`, then
//! synthesize a minimal [`AudioAnalysis`] — a single full-track section
//! with a uniform beat grid generated from the BPM. The result plugs into
//! [`crate::build_sequence`] unchanged.
//!
//! Deezer's public API requires no auth for read endpoints. We use:
//! `GET https://api.deezer.com/track/isrc:{ISRC}`.

use serde::Deserialize;

use crate::{
    analysis::{AudioAnalysis, Section, TimeInterval, TrackSummary},
    api::Track,
    error::{Result, SpotifyError},
};

const DEEZER_BASE: &str = "https://api.deezer.com";

/// Subset of Deezer's track response we care about.
#[derive(Debug, Deserialize)]
struct DeezerTrack {
    #[serde(default)]
    bpm: f32,
    #[serde(default)]
    duration: u32, // seconds
    #[serde(default)]
    gain: f32, // dB-ish replay gain; we map to a section "loudness" proxy
    #[serde(default)]
    error: Option<DeezerError>,
}

#[derive(Debug, Deserialize)]
struct DeezerError {
    #[allow(dead_code)]
    #[serde(default)]
    code: i64,
    #[serde(default)]
    message: String,
}

/// Look up `isrc` on Deezer and return its `bpm` (rounded to 2 dp).
/// Returns `Ok(None)` if Deezer doesn't know the ISRC or returns bpm=0.
pub async fn deezer_bpm_for_isrc(http: &reqwest::Client, isrc: &str) -> Result<Option<DeezerHit>> {
    let trimmed = isrc.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }
    let url = format!("{DEEZER_BASE}/track/isrc:{trimmed}");
    let resp = http.get(&url).send().await?;
    let status = resp.status();
    let body = resp.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(SpotifyError::Api {
            status: status.as_u16(),
            body,
        });
    }
    let parsed: DeezerTrack = serde_json::from_str(&body).map_err(|e| SpotifyError::Api {
        status: 502,
        body: format!("deezer parse error: {e} (body: {body})"),
    })?;
    if let Some(err) = parsed.error {
        tracing::info!(deezer_error = %err.message, isrc, "deezer: no match");
        return Ok(None);
    }
    if parsed.bpm <= 0.0 {
        return Ok(None);
    }
    Ok(Some(DeezerHit {
        bpm: parsed.bpm,
        duration_secs: parsed.duration,
        gain_db: parsed.gain,
    }))
}

/// Convenience wrapper: builds a one-shot reqwest client and calls
/// [`deezer_bpm_for_isrc`]. Use this from callers that don't want to
/// depend on `reqwest` directly.
pub async fn lookup_isrc(isrc: &str) -> Result<Option<DeezerHit>> {
    let http = reqwest::Client::builder()
        .user_agent("christmas-lightshow-app/0.1")
        .build()
        .map_err(SpotifyError::from)?;
    deezer_bpm_for_isrc(&http, isrc).await
}

/// What we got back from Deezer.
#[derive(Debug, Clone, Copy)]
pub struct DeezerHit {
    pub bpm: f32,
    pub duration_secs: u32,
    pub gain_db: f32,
}

/// Synthesize an [`AudioAnalysis`] from a fixed BPM, using the track's
/// own duration for length. Beats are evenly spaced; one section covers
/// the whole track. `bpm` must be > 0.
pub fn synthesize_analysis(track: &Track, hit: DeezerHit) -> AudioAnalysis {
    let bpm = hit.bpm.clamp(40.0, 220.0);
    let duration_secs = if track.duration_ms > 0 {
        track.duration_ms as f32 / 1000.0
    } else {
        hit.duration_secs as f32
    };

    let beat_seconds = 60.0 / bpm;
    let beat_count = if beat_seconds > 0.0 {
        (duration_secs / beat_seconds).floor() as usize
    } else {
        0
    };
    let mut beats = Vec::with_capacity(beat_count);
    for i in 0..beat_count {
        let start = (i as f32) * beat_seconds;
        beats.push(TimeInterval {
            start,
            duration: beat_seconds,
            confidence: 0.6,
        });
    }

    // Synthesize "sections" every 16 beats so the palette rotates a few
    // times across the song instead of being one monolithic block.
    let beats_per_section = 16usize;
    let mut sections = Vec::new();
    if beat_count == 0 {
        sections.push(Section {
            start: 0.0,
            duration: duration_secs,
            confidence: 0.5,
            loudness: -15.0,
            tempo: bpm,
            key: 0,
            mode: 1,
        });
    } else {
        let mut i = 0;
        let mut sec_idx: i32 = 0;
        while i < beat_count {
            let start_b = i;
            let end_b = (i + beats_per_section).min(beat_count);
            let start = beats[start_b].start;
            let end = if end_b < beat_count {
                beats[end_b].start
            } else {
                duration_secs
            };
            sections.push(Section {
                start,
                duration: (end - start).max(0.0),
                confidence: 0.5,
                // Rough loudness proxy from replay gain; Deezer's `gain`
                // is around -10..0 dB for most tracks. Treat as a stand-in
                // for Spotify's section loudness (-30..0).
                loudness: (hit.gain_db - 10.0).clamp(-30.0, 0.0),
                tempo: bpm,
                // Rotate key + mode so `palette_for` paints different
                // sections of the song differently.
                key: sec_idx.rem_euclid(12),
                mode: sec_idx & 1,
            });
            i = end_b;
            sec_idx += 1;
        }
    }

    AudioAnalysis {
        track: TrackSummary {
            duration: duration_secs,
            tempo: bpm,
            tempo_confidence: 0.5,
            key: 0,
            mode: 1,
            time_signature: 4,
        },
        bars: Vec::new(),
        beats,
        tatums: Vec::new(),
        sections,
        segments: Vec::new(),
    }
}
