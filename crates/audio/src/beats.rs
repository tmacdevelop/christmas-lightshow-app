//! Beat detection via spectral flux onset strength.
//!
//! Algorithm overview:
//! 1. Split PCM into overlapping windows (~23 ms hop).
//! 2. Compute FFT magnitude spectrum for each window.
//! 3. Onset strength = sum of positive magnitude differences (positive flux).
//! 4. Smooth the onset curve with a small running average.
//! 5. Pick peaks that exceed a local adaptive threshold with minimum spacing.

use rustfft::{FftPlanner, num_complex::Complex};

/// Detects beat onsets from mono i16 samples.
pub struct BeatDetector {
    sample_rate: u32,
}

impl BeatDetector {
    pub fn new(sample_rate: u32) -> Self {
        Self { sample_rate }
    }

    /// Returns a list of beat timestamps in milliseconds from the start of the
    /// track.
    pub fn detect(&self, samples: &[i16]) -> Vec<u32> {
        let sr = self.sample_rate as usize;

        // Window / hop sizes (~46 ms window, ~11.6 ms hop → ~86 frames/sec).
        let win_size = next_power_of_two(sr * 46 / 1000).max(512);
        let hop_size = win_size / 4;

        if samples.len() < win_size {
            return Vec::new();
        }

        // Build Hann window coefficients.
        let hann: Vec<f32> = (0..win_size)
            .map(|n| {
                0.5 * (1.0 - (2.0 * std::f32::consts::PI * n as f32 / (win_size - 1) as f32).cos())
            })
            .collect();

        let mut planner = FftPlanner::<f32>::new();
        let fft = planner.plan_fft_forward(win_size);

        // Compute magnitude spectrum for each hop.
        let num_frames = (samples.len().saturating_sub(win_size)) / hop_size + 1;
        let mut spectra: Vec<Vec<f32>> = Vec::with_capacity(num_frames);

        let mut buf: Vec<Complex<f32>> = vec![Complex::default(); win_size];

        for frame_idx in 0..num_frames {
            let start = frame_idx * hop_size;
            let end = (start + win_size).min(samples.len());

            for (i, s) in buf.iter_mut().enumerate() {
                let sample = if start + i < end {
                    samples[start + i] as f32 / i16::MAX as f32
                } else {
                    0.0
                };
                s.re = sample * hann[i];
                s.im = 0.0;
            }

            fft.process(&mut buf);

            // Only positive frequencies (first win_size/2 bins).
            let half = win_size / 2;
            let mags: Vec<f32> = buf[..half].iter().map(|c| c.norm()).collect();
            spectra.push(mags);
        }

        // Spectral flux onset strength (positive flux only).
        let mut onset: Vec<f32> = vec![0.0; spectra.len()];
        for i in 1..spectra.len() {
            let flux: f32 = spectra[i]
                .iter()
                .zip(spectra[i - 1].iter())
                .map(|(&cur, &prev)| (cur - prev).max(0.0))
                .sum();
            onset[i] = flux;
        }

        // Smooth onset curve (5-frame moving average).
        let smooth_len = 5usize;
        let mut smoothed = onset.clone();
        for i in smooth_len..onset.len() {
            smoothed[i] = onset[i - smooth_len..=i].iter().sum::<f32>() / (smooth_len + 1) as f32;
        }

        // Adaptive threshold: local mean over ±context frames * multiplier.
        let context = 16usize;
        let threshold_mult = 1.3_f32;

        let min_beat_spacing_frames = {
            // Minimum ~120 ms between beats.
            let min_ms = 120u32;
            (min_ms as usize * sr / 1000) / hop_size
        };

        let mut beats_ms: Vec<u32> = Vec::new();
        let mut last_peak_frame: Option<usize> = None;

        for i in 1..smoothed.len().saturating_sub(1) {
            // Local adaptive threshold.
            let lo = i.saturating_sub(context);
            let hi = (i + context).min(smoothed.len());
            let local_mean = smoothed[lo..hi].iter().sum::<f32>() / (hi - lo) as f32;
            let threshold = local_mean * threshold_mult;

            // Peak condition: above threshold, local maximum.
            let is_peak = smoothed[i] > threshold
                && smoothed[i] > smoothed[i - 1]
                && smoothed[i] >= smoothed[i + 1];

            if is_peak {
                // Enforce minimum spacing.
                let ok = last_peak_frame
                    .map(|lf| i - lf >= min_beat_spacing_frames)
                    .unwrap_or(true);

                if ok {
                    let time_ms = (i * hop_size * 1000 / sr) as u32;
                    beats_ms.push(time_ms);
                    last_peak_frame = Some(i);
                }
            }
        }

        beats_ms
    }
}

fn next_power_of_two(n: usize) -> usize {
    if n == 0 {
        return 1;
    }
    let mut p = 1;
    while p < n {
        p <<= 1;
    }
    p
}
