export interface SpotifyUser {
  id: string;
  display_name?: string | null;
  email?: string | null;
  product?: string | null;
  images?: { url: string; height?: number; width?: number }[];
}

export interface SpotifyAuthStatus {
  authenticated: boolean;
  configured: boolean;
  client_id?: string | null;
  user?: SpotifyUser | null;
}

export interface SpotifyArtist {
  id: string;
  name: string;
}

export interface SpotifyAlbum {
  id: string;
  name: string;
  images: { url: string; height?: number; width?: number }[];
  release_date?: string | null;
}

export interface SpotifyTrack {
  id: string;
  name: string;
  uri: string;
  duration_ms: number;
  explicit: boolean;
  preview_url?: string | null;
  artists: SpotifyArtist[];
  album?: SpotifyAlbum | null;
}

export interface SpotifySearchResponse {
  tracks: { items: SpotifyTrack[]; total: number };
}

export interface SpotifySavedTrack {
  added_at?: string | null;
  track: SpotifyTrack;
}

export interface SpotifySavedTracksPage {
  items: SpotifySavedTrack[];
  total: number;
  limit: number;
  offset: number;
}

/** Slimmer track shape returned inside an album's track listing. */
export interface SpotifyAlbumTrack {
  id: string;
  name: string;
  uri: string;
  duration_ms: number;
  track_number: number;
  disc_number: number;
  explicit: boolean;
  artists: SpotifyArtist[];
}

export interface SpotifyAlbumTracksPage {
  items: SpotifyAlbumTrack[];
  total: number;
  limit: number;
  offset: number;
}

export interface SpotifySavedAlbum {
  id: string;
  name: string;
  uri: string;
  images: { url: string; height?: number; width?: number }[];
  release_date?: string | null;
  total_tracks: number;
  artists: SpotifyArtist[];
  tracks?: SpotifyAlbumTracksPage | null;
}

export interface SpotifySavedAlbumItem {
  added_at?: string | null;
  album: SpotifySavedAlbum;
}

export interface SpotifySavedAlbumsPage {
  items: SpotifySavedAlbumItem[];
  total: number;
  limit: number;
  offset: number;
}

export interface BuildSequenceResponse {
  sequence_id: string;
  clip_count: number;
  duration_ms: number;
}

export interface PlayerSnapshot {
  paused: boolean;
  /** Latest position (ms) reported by the SDK. */
  position_ms: number;
  /** Track duration (ms) at the time of the snapshot. */
  duration_ms: number;
  trackId: string | null;
  trackName: string;
  artists: string;
}

/**
 * A track the user has selected (highlighted) in the Spotify panel. The
 * Music Console reads this to know what to load when the user presses play.
 * Selection is independent of actual playback.
 */
export interface SelectedTrack {
  id: string;
  uri: string;
  name: string;
  /** Comma-joined artist names. */
  artists: string;
  duration_ms: number;
  /** Optional album-art URL. */
  cover?: string;
}
