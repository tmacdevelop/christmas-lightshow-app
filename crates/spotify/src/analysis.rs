//! Subset of Spotify's `audio-analysis` JSON we actually consume.
//!
//! Spotify deprecated this endpoint for *new* third-party apps in late 2024
//! but it remains available for existing/personal-use apps. We treat all
//! fields as optional so the deserializer is tolerant to schema drift.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct AudioAnalysis {
    #[serde(default)]
    pub track: TrackSummary,
    #[serde(default)]
    pub bars: Vec<TimeInterval>,
    #[serde(default)]
    pub beats: Vec<TimeInterval>,
    #[serde(default)]
    pub tatums: Vec<TimeInterval>,
    #[serde(default)]
    pub sections: Vec<Section>,
    #[serde(default)]
    pub segments: Vec<Segment>,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
pub struct TrackSummary {
    #[serde(default)]
    pub duration: f32,
    #[serde(default)]
    pub tempo: f32,
    #[serde(default)]
    pub tempo_confidence: f32,
    #[serde(default)]
    pub key: i32,
    #[serde(default)]
    pub mode: i32,
    #[serde(default)]
    pub time_signature: i32,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
pub struct TimeInterval {
    pub start: f32,
    pub duration: f32,
    #[serde(default)]
    pub confidence: f32,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
pub struct Section {
    pub start: f32,
    pub duration: f32,
    #[serde(default)]
    pub confidence: f32,
    #[serde(default)]
    pub loudness: f32,
    #[serde(default)]
    pub tempo: f32,
    #[serde(default)]
    pub key: i32,
    #[serde(default)]
    pub mode: i32,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
pub struct Segment {
    pub start: f32,
    pub duration: f32,
    #[serde(default)]
    pub confidence: f32,
    #[serde(default)]
    pub loudness_start: f32,
    #[serde(default)]
    pub loudness_max: f32,
    #[serde(default)]
    pub pitches: Vec<f32>,
    #[serde(default)]
    pub timbre: Vec<f32>,
}
