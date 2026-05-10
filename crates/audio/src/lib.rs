//! Audio analysis crate for the Christmas light show.
//!
//! Provides:
//! - [`decode`] — decode an audio file (MP3/WAV/OGG/FLAC) to mono PCM.
//! - [`BeatDetector`] — detect beat onsets from PCM samples.
//! - [`AudioAnalysis`] — combined analysis result: duration, BPM, beat timestamps.

mod beats;
mod decoder;

pub use beats::BeatDetector;
pub use decoder::decode_to_mono;

use serde::{Deserialize, Serialize};

/// The result of analysing an uploaded audio track.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AudioAnalysis {
    /// Track duration in milliseconds.
    pub duration_ms: u64,
    /// Audio sample rate in Hz.
    pub sample_rate: u32,
    /// Estimated BPM (0.0 if not enough beats were detected).
    pub bpm: f32,
    /// Timestamps (ms from start) where a beat onset was detected.
    pub beats_ms: Vec<u32>,
    /// RMS amplitude of the track (0.0–1.0, useful for brightness scaling).
    pub rms: f32,
}

/// Decode and analyse an audio file from raw bytes.
///
/// Accepts any format supported by `symphonia` (MP3, WAV, OGG, FLAC, AAC).
/// Returns [`AudioAnalysis`] on success.
pub fn analyse(data: &[u8]) -> anyhow::Result<AudioAnalysis> {
    let (samples, sample_rate) = decode_to_mono(data)?;

    let duration_ms = (samples.len() as f64 / sample_rate as f64 * 1000.0) as u64;

    let rms = {
        let sum_sq: f64 = samples.iter().map(|&s| (s as f64) * (s as f64)).sum();
        ((sum_sq / samples.len() as f64).sqrt() / i16::MAX as f64) as f32
    };

    let beats_ms = BeatDetector::new(sample_rate).detect(&samples);

    let bpm = if beats_ms.len() >= 2 {
        let intervals: Vec<f32> = beats_ms.windows(2).map(|w| (w[1] - w[0]) as f32).collect();
        let mean_interval_ms = intervals.iter().sum::<f32>() / intervals.len() as f32;
        60_000.0 / mean_interval_ms
    } else {
        0.0
    };

    tracing::info!(
        duration_ms,
        sample_rate,
        bpm,
        beat_count = beats_ms.len(),
        "audio analysis complete"
    );

    Ok(AudioAnalysis {
        duration_ms,
        sample_rate,
        bpm,
        beats_ms,
        rms,
    })
}
