//! Spotify integration crate (Phase: SPOTIFY_PLAN.md).
//!
//! Provides:
//! - PKCE OAuth via [`auth::Auth`]
//! - Encrypted token persistence via [`token_store::TokenStore`]
//! - Thin Spotify Web API client via [`api::ApiClient`]
//! - On-disk JSON cache for `audio-analysis` results via [`cache::AnalysisCache`]
//! - Conversion of Spotify analysis → our [`sequencer::Sequence`]
//!   via [`sequence_builder::build_sequence`]

pub mod analysis;
pub mod api;
pub mod auth;
pub mod cache;
pub mod error;
pub mod fallback;
pub mod sequence_builder;
pub mod token_store;

pub use analysis::AudioAnalysis;
pub use api::{ApiClient, SearchResponse, Track, UserProfile};
pub use auth::Auth;
pub use cache::AnalysisCache;
pub use error::{Result, SpotifyError};
pub use fallback::{DeezerHit, deezer_bpm_for_isrc, lookup_isrc, synthesize_analysis};
pub use sequence_builder::build_sequence;
pub use token_store::TokenStore;
