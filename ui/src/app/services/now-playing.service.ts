import { Injectable, computed, effect, inject } from '@angular/core';

import { AudioService } from './audio.service';
import { SequenceService } from './sequence.service';
import { SequencerTransportService } from './sequencer-transport.service';
import { SpotifyService } from './spotify.service';
import { persistedSignal } from '../util/persisted-signal';
import type { AudioTrack } from '../models/audio.models';
import type { Sequence } from '../models/sequence.models';

/**
 * Discriminated union describing where the *loaded* track originates from.
 *
 * - `upload`  — a file the user uploaded to the Music tab. Always has a
 *   generated sequence (we run beat detection at upload time).
 * - `spotify` — a track from the Spotify catalogue. The sequence id is
 *   optional: when no Deezer BPM is available the track is still loadable
 *   so it can play music-only (or, in a future slice, drive a `Reactive`
 *   effect from the mic).
 * - `live`    — reserved for slice 2 (mic / line-in driven Reactive mode).
 */
export type MusicSource =
  | { kind: 'upload'; trackId: string; sequenceId: string }
  | {
      kind: 'spotify';
      trackId: string;
      uri: string;
      sequenceId: string | null;
    };

/** What the player UI needs to render a now-playing block. */
export interface LoadedSource {
  source: MusicSource;
  name: string;
  artists: string;
  durationMs: number;
  cover?: string;
}

/**
 * Single source of truth for *what is loaded into the player*. Phase 4b
 * coordinator: every source panel (Spotify, Music uploads, future Live
 * input) loads tracks through here and the footer Music Console reads
 * exclusively from this service.
 *
 * Internally we delegate the actual playback to the existing services
 * ({@link SequencerTransportService}, {@link SpotifyService}, etc.) so this
 * is purely a routing/coordination layer — the heavy lifting stays where
 * it already lives.
 */
@Injectable({ providedIn: 'root' })
export class NowPlayingService {
  private readonly spotify = inject(SpotifyService);
  private readonly transport = inject(SequencerTransportService);
  private readonly sequences = inject(SequenceService);
  private readonly audio = inject(AudioService);

  /**
   * Currently loaded source (or null if nothing has been loaded).
   * Persisted to `localStorage` so a browser refresh keeps the footer
   * Music Console populated even though the Spotify SDK / engine state
   * has to be rebuilt from scratch.
   */
  readonly loaded = persistedSignal<LoadedSource | null>(
    'np.loaded',
    null,
    { sanitize: sanitizeLoaded },
  );

  constructor() {
    // After a browser refresh, the persisted `loaded` rehydrates before
    // the rest of the app boots. Sync the dependent transports/services
    // so the footer transport, timeline, and Spotify "selected" state all
    // line up with what the user last loaded.
    const ld = this.loaded();
    if (ld) {
      void this.rehydrate(ld);
    }

    // Mirror sequences picked through other entry points (Timeline
    // dropdown auto-selecting the first library entry, transport.play()
    // from the footer, etc.) into `loaded` so the now-playing block
    // always reflects what the engine is actually running. Without this
    // the footer says "No song selected" whenever the show was started
    // outside the Spotify/Music tabs.
    effect(() => {
      const current = this.transport.current();
      if (!current) return;
      const ld = this.loaded();
      if (
        ld &&
        ((ld.source.kind === 'upload' && ld.source.sequenceId === current.id) ||
          (ld.source.kind === 'spotify' &&
            ld.source.sequenceId === current.id))
      ) {
        return;
      }
      this.loaded.set(this.fromSequence(current));
    });
  }

  /**
   * Synthesize a {@link LoadedSource} from a `Sequence` we found in the
   * transport but didn't load through this service. Used to recover the
   * now-playing block when the Timeline auto-selected a library entry.
   *
   * Spotify-prefixed ids (`spotify-{trackId}`) are mapped to a `spotify`
   * source; everything else is treated as an `upload` source whose
   * `trackId` is the sequence id itself (good enough for footer display).
   */
  private fromSequence(seq: Sequence): LoadedSource {
    const m = /^spotify-([A-Za-z0-9]+)$/.exec(seq.id);
    if (m) {
      const trackId = m[1];
      // Mirror to the legacy selected slot too so spotify-aware code
      // (e.g. transport play, music console) keeps working.
      this.spotify.selectedTrack.set({
        id: trackId,
        uri: `spotify:track:${trackId}`,
        name: seq.name,
        artists: '',
        duration_ms: seq.duration_ms,
      });
      return {
        source: {
          kind: 'spotify',
          trackId,
          uri: `spotify:track:${trackId}`,
          sequenceId: seq.id,
        },
        name: seq.name,
        artists: '',
        durationMs: seq.duration_ms,
      };
    }
    this.spotify.selectedTrack.set({
      id: seq.id,
      uri: '',
      name: seq.name,
      artists: '',
      duration_ms: seq.duration_ms,
    });
    return {
      source: {
        kind: 'upload',
        trackId: seq.id,
        sequenceId: seq.id,
      },
      name: seq.name,
      artists: '',
      durationMs: seq.duration_ms,
    };
  }

  readonly hasSequence = computed(() => {
    const ld = this.loaded();
    if (!ld) return false;
    return ld.source.kind === 'upload' || ld.source.sequenceId !== null;
  });

  // ---------- loaders ----------

  /**
   * Load a Spotify track into the player. Attempts to generate (or fetch)
   * a sequence first; if the track has no usable analysis (e.g. Deezer
   * has no BPM for the ISRC) the track is still loaded with
   * `sequenceId: null` so the user can at least play the song.
   */
  async loadSpotify(track: {
    id: string;
    uri: string;
    name: string;
    artists: string;
    duration_ms: number;
    cover?: string;
  }): Promise<{ sequenceId: string | null; error?: string }> {
    let sequenceId: string | null = null;
    let seq: Sequence | null = null;
    let error: string | undefined;
    try {
      const built = await this.spotify.generateSequence(track.id);
      sequenceId = built.sequence_id;
      // Refresh local cache so other consumers see the new sequence.
      try {
        seq = await this.sequences.get(sequenceId);
      } catch {
        seq = null;
      }
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }

    this.transport.setCurrent(seq);
    this.loaded.set({
      source: {
        kind: 'spotify',
        trackId: track.id,
        uri: track.uri,
        sequenceId,
      },
      name: track.name,
      artists: track.artists,
      durationMs: track.duration_ms,
      cover: track.cover,
    });
    // Mirror into the legacy `selectedTrack` so the existing music-console
    // now-playing UI continues to work without changes.
    this.spotify.selectedTrack.set({
      id: track.id,
      uri: track.uri,
      name: track.name,
      artists: track.artists,
      duration_ms: track.duration_ms,
      cover: track.cover,
    });
    return { sequenceId, error };
  }

  /**
   * Load an uploaded audio track into the player. Always generates the
   * beat-synced sequence (cheap if it already exists server-side) so the
   * upload arrives in the player ready to play lights immediately.
   */
  async loadUpload(track: AudioTrack): Promise<string> {
    // `generate` is idempotent server-side: returns the existing sequence
    // when one already matches.
    const seq = await this.audio.generate(track.id);
    this.transport.setCurrent(seq);
    this.loaded.set({
      source: {
        kind: 'upload',
        trackId: track.id,
        sequenceId: seq.id,
      },
      name: track.filename,
      artists: this.formatTrackMeta(track),
      durationMs: track.analysis.duration_ms,
    });
    // Surface the upload in the music-console now-playing block too.
    // Use an empty uri so the existing Spotify-aware play branch is
    // skipped and the transport drives the engine alone.
    this.spotify.selectedTrack.set({
      id: track.id,
      uri: '',
      name: track.filename,
      artists: this.formatTrackMeta(track),
      duration_ms: track.analysis.duration_ms,
    });
    return seq.id;
  }

  /** Clear the loaded source. Does not stop playback. */
  unload(): void {
    this.loaded.set(null);
    this.transport.setCurrent(null);
    this.spotify.selectedTrack.set(null);
  }

  private formatTrackMeta(t: AudioTrack): string {
    const bpm = Math.round(t.analysis.bpm);
    return `${bpm} BPM · ${t.analysis.beats_ms.length} beats`;
  }

  /**
   * Re-attach the persisted {@link LoadedSource} to the rest of the app on
   * boot. Fetches the underlying `Sequence` so the transport's `current`
   * (and the Timeline editor) reflect the loaded show, and mirrors the
   * track into the legacy `selectedTrack` slot used by some panels.
   */
  private async rehydrate(ld: LoadedSource): Promise<void> {
    // Mirror into the legacy "selected" slot so panels that still read it
    // see the right track immediately, before any network I/O.
    const uri = ld.source.kind === 'spotify' ? ld.source.uri : '';
    this.spotify.selectedTrack.set({
      id: ld.source.trackId,
      uri,
      name: ld.name,
      artists: ld.artists,
      duration_ms: ld.durationMs,
      cover: ld.cover,
    });

    // Re-fetch the sequence (if any) so the Timeline + transport line up.
    const seqId =
      ld.source.kind === 'upload'
        ? ld.source.sequenceId
        : ld.source.sequenceId;
    if (seqId) {
      try {
        const seq = await this.sequences.get(seqId);
        this.transport.setCurrent(seq);
      } catch {
        // Sequence was deleted server-side. Drop the loaded source so
        // the UI doesn't keep referencing a missing show.
        this.loaded.set(null);
        this.transport.setCurrent(null);
        this.spotify.selectedTrack.set(null);
      }
    }
  }
}

/**
 * Defensive sanitizer for `persistedSignal` — drops any payload whose
 * shape doesn't match the current {@link LoadedSource} contract. Keeps the
 * stored value backwards-compatible across schema changes.
 */
function sanitizeLoaded(value: unknown): LoadedSource | null | undefined {
  if (value === null) return null;
  if (!value || typeof value !== 'object') return undefined;
  const v = value as Record<string, unknown>;
  const src = v['source'];
  if (!src || typeof src !== 'object') return undefined;
  const s = src as Record<string, unknown>;
  const kind = s['kind'];
  const trackId = s['trackId'];
  if (typeof trackId !== 'string') return undefined;
  if (kind === 'upload') {
    const seqId = s['sequenceId'];
    if (typeof seqId !== 'string') return undefined;
  } else if (kind === 'spotify') {
    if (typeof s['uri'] !== 'string') return undefined;
    const seqId = s['sequenceId'];
    if (seqId !== null && typeof seqId !== 'string') return undefined;
  } else {
    return undefined;
  }
  if (typeof v['name'] !== 'string') return undefined;
  if (typeof v['artists'] !== 'string') return undefined;
  if (typeof v['durationMs'] !== 'number') return undefined;
  return value as LoadedSource;
}
