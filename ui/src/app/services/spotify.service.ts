import { Injectable, inject, signal } from '@angular/core';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import {
  persistedSignal,
  clampNumber,
} from '../util/persisted-signal';

export type {
  SpotifyUser,
  SpotifyAuthStatus,
  SpotifyArtist,
  SpotifyAlbum,
  SpotifyTrack,
  SpotifySearchResponse,
  SpotifySavedTrack,
  SpotifySavedTracksPage,
  SpotifyAlbumTrack,
  SpotifyAlbumTracksPage,
  SpotifySavedAlbum,
  SpotifySavedAlbumItem,
  SpotifySavedAlbumsPage,
  BuildSequenceResponse,
  PlayerSnapshot,
  SelectedTrack,
} from '../models/spotify.models';
import type {
  SpotifyAuthStatus,
  SpotifyTrack,
  SpotifySearchResponse,
  SpotifySavedTracksPage,
  SpotifyAlbumTracksPage,
  SpotifySavedAlbumsPage,
  BuildSequenceResponse,
  PlayerSnapshot,
  SelectedTrack,
} from '../models/spotify.models';

const API_BASE = '/api/spotify';
const PLAYBACK_SYNC_URL = '/api/playback/sync';

/**
 * REST client for the Spotify integration endpoints exposed under
 * `/api/spotify/*`. See `SPOTIFY_PLAN.md`.
 *
 * This first cut covers PKCE auth, search, and analysis-driven sequence
 * generation. Web Playback SDK + external sync arrive in a later phase.
 */
@Injectable({ providedIn: 'root' })
export class SpotifyService {
  private readonly http = inject(HttpClient);

  readonly status = signal<SpotifyAuthStatus>({
    authenticated: false,
    configured: false,
  });
  readonly searchResults = signal<SpotifyTrack[]>([]);
  readonly lastError = signal<string | null>(null);
  readonly busy = signal(false);

  /** Web Playback SDK lifecycle / state signals. */
  readonly playerReady = signal(false);
  readonly deviceId = signal<string | null>(null);
  readonly playerSnapshot = signal<PlayerSnapshot | null>(null);
  /** Live-interpolated playhead in ms. Ticks via the sync loop so the UI
   * progress bar/time advance smoothly between sporadic SDK state events. */
  readonly livePlayHeadMs = signal(0);
  /** Track the user has highlighted in the panel. Drives the Music Console;
   * independent of what is actually playing. Persisted so a refresh keeps the
   * console populated. */
  readonly selectedTrack = persistedSignal<SelectedTrack | null>(
    'mc.selectedTrack',
    null,
  );
  /** Current volume 0..1. Mirrors what we last sent to `player.setVolume`. */
  readonly volume = persistedSignal('mc.volume', 0.8, {
    sanitize: clampNumber(0, 1),
  });
  /** When true, the SDK volume is held at 0 but `volume` remembers the
   * pre-mute level so unmute restores it. */
  readonly muted = persistedSignal('mc.muted', false, {
    sanitize: (v) => (typeof v === 'boolean' ? v : undefined),
  });
  private preMuteVolume = 0.8;

  private player: Spotify.Player | null = null;
  private sdkReadyPromise: Promise<void> | null = null;
  /** Reference clock for dead-reckoning playhead between SDK events. */
  private referencePosition = 0;
  private referenceClockMs = 0;
  private snapshotPaused = true;
  /**
   * Suppress pushing `playing: false` to the engine until the SDK has
   * confirmed actual playback (paused:false) at least once for this
   * track. Without this, the SDK's initial buffering events (which
   * report paused:true at position 0) clobber the engine's `playing`
   * flag immediately after `transport.play()` started the show — leaving
   * the simulator stuck at black with `external_sync:true`,
   * `playing:false`. We only start mirroring the SDK's pause state after
   * the first real "playing" event.
   */
  private hasSeenPlaying = false;
  /** ID returned by `setInterval` for the 30s heartbeat push loop. */
  private syncTimer: number | null = null;
  /**
   * Local-only animation timer that ticks {@link livePlayHeadMs} so the
   * UI seek bar stays smooth between (now-rare) network pushes. No fetch.
   */
  private uiTickTimer: number | null = null;

  async refreshStatus(): Promise<SpotifyAuthStatus> {
    return this.run(async () => {
      const s = await firstValueFrom(
        this.http.get<SpotifyAuthStatus>(`${API_BASE}/auth/status`),
      );
      this.status.set(s);
      return s;
    });
  }

  /**
   * Begin the PKCE login. Asks the backend for the authorize URL, then
   * navigates the current tab to Spotify. After the user grants access,
   * Spotify redirects back to `/api/spotify/auth/callback`, which in turn
   * redirects to `/?spotify=ok`.
   */
  async login(): Promise<void> {
    const { authorize_url } = await firstValueFrom(
      this.http.get<{ authorize_url: string }>(`${API_BASE}/auth/login`),
    );
    window.location.href = authorize_url;
  }

  async logout(): Promise<void> {
    this.disconnectPlayer();
    await firstValueFrom(
      this.http.post<void>(`${API_BASE}/auth/logout`, {}),
    );
    this.status.set({ authenticated: false, configured: this.status().configured });
  }

  async search(query: string, limit = 20): Promise<SpotifyTrack[]> {
    return this.run(async () => {
      if (!query.trim()) {
        this.searchResults.set([]);
        return [];
      }
      const params = new URLSearchParams({ q: query, limit: String(limit) });
      const resp = await firstValueFrom(
        this.http.get<SpotifySearchResponse>(`${API_BASE}/search?${params}`),
      );
      const items = resp.tracks?.items ?? [];
      this.searchResults.set(items);
      return items;
    });
  }

  async generateSequence(trackId: string): Promise<BuildSequenceResponse> {
    return this.run(() =>
      firstValueFrom(
        this.http.post<BuildSequenceResponse>(
          `${API_BASE}/track/${trackId}/sequence`,
          {},
        ),
      ),
    );
  }

  /** GET `/api/spotify/library/tracks` — user's "Liked Songs". */
  async libraryTracks(
    limit = 50,
    offset = 0,
  ): Promise<SpotifySavedTracksPage> {
    return this.run(() =>
      firstValueFrom(
        this.http.get<SpotifySavedTracksPage>(
          `${API_BASE}/library/tracks?limit=${limit}&offset=${offset}`,
        ),
      ),
    );
  }

  /** GET `/api/spotify/library/albums` — user's saved albums. */
  async libraryAlbums(
    limit = 50,
    offset = 0,
  ): Promise<SpotifySavedAlbumsPage> {
    return this.run(() =>
      firstValueFrom(
        this.http.get<SpotifySavedAlbumsPage>(
          `${API_BASE}/library/albums?limit=${limit}&offset=${offset}`,
        ),
      ),
    );
  }

  /** GET `/api/spotify/album/:id/tracks` — album's track listing. */
  async albumTracks(
    albumId: string,
    limit = 50,
    offset = 0,
  ): Promise<SpotifyAlbumTracksPage> {
    return this.run(() =>
      firstValueFrom(
        this.http.get<SpotifyAlbumTracksPage>(
          `${API_BASE}/album/${albumId}/tracks?limit=${limit}&offset=${offset}`,
        ),
      ),
    );
  }

  private async run<T>(fn: () => Promise<T>): Promise<T> {
    this.busy.set(true);
    try {
      const v = await fn();
      this.lastError.set(null);
      return v;
    } catch (err: unknown) {
      this.lastError.set(formatError(err));
      throw err;
    } finally {
      this.busy.set(false);
    }
  }

  // ---------------------------- Web Playback SDK ----------------------------

  /**
   * Lazily fetch a Spotify access token from the backend (already refreshed
   * server-side if it was near expiry). Used by the SDK's `getOAuthToken`.
   */
  private async fetchAccessToken(): Promise<string> {
    const resp = await firstValueFrom(
      this.http.get<{ access_token: string }>(`${API_BASE}/auth/token`),
    );
    return resp.access_token;
  }

  /**
   * Wait until the global Spotify SDK script is ready. The CDN script calls
   * `window.onSpotifyWebPlaybackSDKReady` exactly once when it loads.
   */
  private waitForSdk(): Promise<void> {
    if (this.sdkReadyPromise) return this.sdkReadyPromise;
    this.sdkReadyPromise = new Promise<void>((resolve, reject) => {
      if (typeof window === 'undefined') {
        reject(new Error('window unavailable (SSR)'));
        return;
      }
      if (window.Spotify) {
        resolve();
        return;
      }
      const prev = window.onSpotifyWebPlaybackSDKReady;
      window.onSpotifyWebPlaybackSDKReady = () => {
        prev?.();
        resolve();
      };
      // Safety net: if the script never loads, fail after 15s.
      setTimeout(() => {
        if (!window.Spotify) {
          reject(new Error('Spotify Web Playback SDK failed to load'));
        }
      }, 15_000);
    });
    return this.sdkReadyPromise;
  }

  /**
   * Initialise the Web Playback SDK player. Idempotent — safe to call
   * multiple times. Must be called from a user gesture in some browsers
   * because creating an audio context is gated.
   */
  async initPlayer(): Promise<void> {
    if (this.player) return;
    if (!this.status().authenticated) {
      throw new Error('not logged in to Spotify');
    }
    await this.waitForSdk();
    if (!window.Spotify) {
      throw new Error('Spotify SDK unavailable');
    }

    const player = new window.Spotify.Player({
      name: 'Christmas Light Show',
      getOAuthToken: (cb) => {
        this.fetchAccessToken()
          .then((token) => cb(token))
          .catch((err) => {
            this.lastError.set(`token fetch failed: ${err}`);
          });
      },
      volume: 0.8,
    });

    player.addListener('ready', ({ device_id }) => {
      this.deviceId.set(device_id);
      this.playerReady.set(true);
    });
    player.addListener('not_ready', () => {
      this.playerReady.set(false);
    });
    player.addListener('initialization_error', ({ message }) => {
      this.lastError.set(`SDK init error: ${message}`);
    });
    player.addListener('authentication_error', ({ message }) => {
      this.lastError.set(`SDK auth error: ${message}`);
    });
    player.addListener('account_error', ({ message }) => {
      this.lastError.set(
        `Spotify Premium required: ${message}`,
      );
    });
    player.addListener('playback_error', ({ message }) => {
      this.lastError.set(`Playback error: ${message}`);
    });
    player.addListener('player_state_changed', (state) => {
      this.onPlayerState(state);
    });

    const connected = await player.connect();
    if (!connected) {
      throw new Error('SDK player.connect() returned false');
    }
    this.player = player;
    this.startSyncLoop();
  }

  /** Tear down the player and stop pushing playhead. */
  disconnectPlayer(): void {
    this.stopSyncLoop();
    this.player?.disconnect();
    this.player = null;
    this.playerReady.set(false);
    this.deviceId.set(null);
    this.playerSnapshot.set(null);
    this.hasSeenPlaying = false;
  }

  /**
   * Start playback of `trackUri` on our SDK device. Requires Premium.
   * Uses the regular Spotify Connect endpoint with `device_id`.
   *
   * `positionMs` (optional) starts the track at that offset, avoiding the
   * race where the SDK reports `position_ms: 0` for a tick before a
   * follow-up `seek` takes effect.
   */
  async playUri(trackUri: string, positionMs?: number): Promise<void> {
    const deviceId = this.deviceId();
    if (!deviceId) {
      throw new Error('SDK device not ready yet');
    }
    const token = await this.fetchAccessToken();
    const body: Record<string, unknown> = { uris: [trackUri] };
    if (typeof positionMs === 'number' && positionMs > 0) {
      body['position_ms'] = Math.floor(positionMs);
    }
    const resp = await fetch(
      `https://api.spotify.com/v1/me/player/play?device_id=${deviceId}`,
      {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      },
    );
    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      throw new Error(`Spotify play failed (${resp.status}): ${body}`);
    }
  }

  async togglePlay(): Promise<void> {
    await this.player?.togglePlay();
  }

  async pause(): Promise<void> {
    await this.player?.pause();
  }

  async resume(): Promise<void> {
    await this.player?.resume();
  }

  async seek(positionMs: number): Promise<void> {
    await this.player?.seek(Math.max(0, Math.floor(positionMs)));
  }

  /** Restart the current track from 00:00. */
  async restart(): Promise<void> {
    await this.seek(0);
    await this.resume();
  }

  /** Set SDK volume (0..1). Clears mute. */
  async setVolume(value: number): Promise<void> {
    const v = Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
    this.volume.set(v);
    if (v > 0) this.muted.set(false);
    await this.player?.setVolume(v);
  }

  /** Mute or unmute. Mute preserves the previous volume for restore. */
  async toggleMute(): Promise<void> {
    if (this.muted()) {
      this.muted.set(false);
      const restore = this.preMuteVolume > 0 ? this.preMuteVolume : 0.5;
      this.volume.set(restore);
      await this.player?.setVolume(restore);
    } else {
      this.preMuteVolume = this.volume();
      this.muted.set(true);
      await this.player?.setVolume(0);
    }
  }

  /**
   * Convenience: initialise the SDK if needed, wait for a device, and play
   * `trackUri`. Used by the Spotify panel's per-row "Play" button so the
   * user can audition a song without generating a sequence first.
   *
   * `positionMs` is forwarded to the play endpoint so playback begins at
   * the desired offset in a single round-trip — important when a play
   * range is active and we need the song to start *inside* the range
   * without a brief jump from 0.
   */
  async ensurePlaying(trackUri: string, positionMs?: number): Promise<void> {
    await this.initPlayer();
    if (!this.deviceId()) {
      const start = performance.now();
      while (performance.now() - start < 5_000 && !this.deviceId()) {
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    await this.playUri(trackUri, positionMs);
  }

  // -- internal: playhead bookkeeping --------------------------------------

  private onPlayerState(state: Spotify.PlaybackState | null): void {
    if (!state) {
      this.snapshotPaused = true;
      return;
    }
    const currentTrack = state.track_window?.current_track;
    this.referencePosition = state.position;
    this.referenceClockMs = performance.now();
    this.snapshotPaused = state.paused;
    // Once the SDK reports actual playback for this track, allow future
    // paused-state pushes to mirror onto the engine. Until then, we treat
    // SDK paused as a buffering/init transient and don't override the
    // engine's `playing` flag (set by /sequences/:id/play).
    if (!state.paused) {
      this.hasSeenPlaying = true;
    }
    this.livePlayHeadMs.set(state.position);
    // Spotify track relinking: when the catalogue serves an alternate
    // master (region-specific re-release, etc.), `current_track.id` is
    // the served master's id and `linked_from.id` carries the id we
    // originally requested. Surface the requested id so callers that
    // matched on it stay in sync.
    const requestedId = currentTrack?.linked_from?.id ?? currentTrack?.id ?? null;
    // Reset the "has played" gate when the track actually changes, so a
    // freshly-loaded track gets its own buffering grace period before
    // its initial paused state is mirrored onto the engine.
    const prevId = this.playerSnapshot()?.trackId ?? null;
    if (requestedId !== prevId) {
      this.hasSeenPlaying = !state.paused;
    }
    this.playerSnapshot.set({
      paused: state.paused,
      position_ms: state.position,
      duration_ms: state.duration,
      trackId: requestedId,
      trackName: currentTrack?.name ?? '',
      artists: '',
    });
    // Push the new anchor to the server now — this is the only time
    // anything changed. Between events the server extrapolates from this
    // anchor using its own wall clock, so we don't need to keep ticking.
    void this.pushPlayhead();
  }

  /**
   * Latest interpolated playhead in ms (from the last SDK reference + wall
   * clock). Public so render loops (e.g. the timeline) can pull a smooth,
   * monotonic position without re-reading signals on every animation frame.
   */
  interpolatedPosition(): number {
    if (this.snapshotPaused) return this.referencePosition;
    const elapsed = performance.now() - this.referenceClockMs;
    return this.referencePosition + Math.max(0, elapsed);
  }

  private startSyncLoop(): void {
    if (this.syncTimer != null) return;
    // Event-driven sync: we only POST to /playback/sync on actual SDK
    // events (play/pause/seek/track-change — see {@link onPlayerState}).
    // Between events the server extrapolates from the last anchor with
    // its own clock, so the only reason to tick is a defensive heartbeat
    // that proves the SDK is still alive. 30s is plenty.
    this.syncTimer = window.setInterval(() => {
      this.pushPlayhead();
    }, 30_000);
    // Local UI tick (no network) — keeps the seek bar smooth. 4 Hz looks
    // continuous enough at typical seek-bar widths and is essentially
    // free.
    if (this.uiTickTimer == null) {
      this.uiTickTimer = window.setInterval(() => {
        if (!this.playerSnapshot()) return;
        const position_ms = Math.floor(this.interpolatedPosition());
        const duration = this.playerSnapshot()?.duration_ms ?? 0;
        this.livePlayHeadMs.set(
          duration > 0 ? Math.min(position_ms, duration) : position_ms,
        );
      }, 250);
    }
  }

  private stopSyncLoop(): void {
    if (this.syncTimer != null) {
      window.clearInterval(this.syncTimer);
      this.syncTimer = null;
    }
    if (this.uiTickTimer != null) {
      window.clearInterval(this.uiTickTimer);
      this.uiTickTimer = null;
    }
  }

  private inflightSync = false;
  private async pushPlayhead(): Promise<void> {
    if (this.inflightSync) return;
    if (!this.playerSnapshot()) return;
    // Until the SDK has confirmed this track is actually playing, don't
    // touch the engine: otherwise we'd lock its external playhead to
    // position 0 (and possibly toggle `playing:false`) during the
    // initial buffering events fired right after `play()`/`load()`,
    // freezing the simulator at black with `external_sync:true`.
    if (!this.hasSeenPlaying) return;
    this.inflightSync = true;
    try {
      const position_ms = Math.floor(this.interpolatedPosition());
      const playing = !this.snapshotPaused;
      const duration = this.playerSnapshot()?.duration_ms ?? 0;
      this.livePlayHeadMs.set(
        duration > 0 ? Math.min(position_ms, duration) : position_ms,
      );
      await fetch(PLAYBACK_SYNC_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ position_ms, playing }),
        credentials: 'same-origin',
      });
    } catch {
      // Silent — the next SDK event (or heartbeat) will retry.
    } finally {
      this.inflightSync = false;
    }
  }
}

function formatError(err: unknown): string {
  if (err instanceof HttpErrorResponse) {
    // Prefer server-provided error payloads.
    const body = err.error;
    if (typeof body === 'string' && body.trim().length > 0) {
      return body;
    }
    if (body && typeof body === 'object') {
      const rec = body as Record<string, unknown>;
      const candidate = rec['error'] ?? rec['message'] ?? rec['detail'];
      if (typeof candidate === 'string' && candidate.trim().length > 0) {
        return candidate;
      }
    }
    if (err.message) return err.message;
    return `HTTP ${err.status} ${err.statusText || ''}`.trim();
  }
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}
