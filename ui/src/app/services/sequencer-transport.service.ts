import { Injectable, computed, effect, inject, signal, untracked } from '@angular/core';

import { SequenceService } from './sequence.service';
import { ShowControlService } from './show-control.service';
import { SpotifyService } from './spotify.service';
import type { Sequence } from '../models/sequence.models';

/**
 * Tolerance (ms) before a divergence between the server's reported
 * playhead and our local extrapolation forces a re-anchor. Below this we
 * trust extrapolation so the playhead stays monotonic; above it we treat
 * the difference as a real seek (or clock drift) and snap to the server.
 */
const PLAYHEAD_RESYNC_MS = 500;

/**
 * Single source of truth for sequence (light show) transport.
 *
 * Both the Timeline editor and the persistent footer Music Console read and
 * drive playback through this service so there is exactly one place that owns
 * "is a show playing", the loop range, and the music ↔ lights coupling.
 *
 * The Timeline keeps ownership of the *editing* working copy and mirrors it
 * here via {@link setCurrent}; the footer hosts the actual Play/Stop/Loop and
 * range transport buttons.
 */
@Injectable({ providedIn: 'root' })
export class SequencerTransportService {
  private readonly sequences = inject(SequenceService);
  private readonly control = inject(ShowControlService);
  private readonly spotify = inject(SpotifyService);

  /** Working copy of the sequence currently open in the editor (or null). */
  readonly current = signal<Sequence | null>(null);

  /** Loop the whole sequence when no explicit play range is set. */
  readonly looping = signal<boolean>(true);

  /** Playback range — when both are non-null, Play loops between them. */
  readonly rangeStartMs = signal<number | null>(null);
  readonly rangeEndMs = signal<number | null>(null);

  readonly currentId = computed(() => this.current()?.id ?? null);
  readonly currentName = computed(() => this.current()?.name ?? null);
  readonly durationMs = computed(() => this.current()?.duration_ms ?? 0);
  readonly rangeActive = computed(
    () => this.rangeStartMs() !== null && this.rangeEndMs() !== null,
  );

  /**
   * If the loaded sequence was generated from a Spotify track its id is
   * `spotify-{trackId}`. Surface the URI so playback can drive Spotify in
   * sync with the lights.
   */
  readonly spotifyTrackUri = computed<string | null>(() => {
    const id = this.currentId();
    if (!id) return null;
    const match = /^spotify-([A-Za-z0-9]+)$/.exec(id);
    return match ? `spotify:track:${match[1]}` : null;
  });
  readonly spotifyAuthed = computed(
    () => this.spotify.status().authenticated,
  );

  /**
   * Server-reported playhead (ms). Updates only when the WS pushes a new
   * status (i.e. on play/pause/seek/track-end). Consumers that need a
   * smoothly-ticking position between pushes should interpolate from
   * {@link playheadAnchor} using `performance.now()` directly in their
   * render loop — doing it here would force change detection at the tick
   * rate and cause sibling controls to flicker.
   */
  readonly playheadMs = computed<number | null>(() => {
    const pb = this.control.status()?.playback;
    if (!pb || pb.mode !== 'sequence') return null;
    if (pb.sequence_id !== this.currentId()) return null;
    return pb.position_ms;
  });
  readonly isPlaying = computed(() => this.playheadMs() !== null);

  /**
   * Anchor for client-side dead-reckoning of the playhead between status
   * pushes.
   *
   * The server emits a status frame every ~100ms while a sequence plays.
   * If we re-anchored on every frame the playhead would visibly stutter
   * (each frame "rewinds" the displayed position by the WS round-trip
   * latency). Instead we only re-anchor on meaningful transitions:
   *   - play \u2194 pause toggle
   *   - sequence id change
   *   - a real seek (server position jumps away from our extrapolation)
   * Between those, consumers extrapolate with their own clock and stay
   * monotonic.
   */
  readonly playheadAnchor = signal<
    { posMs: number; clockMs: number; playing: boolean } | null
  >(null);

  /** Guard: avoid issuing parallel sync requests while one is in flight. */
  private rangeResyncing = false;

  constructor() {
    // Re-anchor the playhead only on meaningful transitions. The server
    // ticks status every ~100ms while playing; re-anchoring on every tick
    // would visibly stutter (each anchor sets clockMs=now but posMs
    // reflects the server's clock at JSON-build time, not now, so the
    // displayed position rewinds by the network latency every push).
    //
    // Drift correction: if the server's reported position diverges from
    // our extrapolation by more than {@link PLAYHEAD_RESYNC_MS}, we treat
    // it as a real seek (or accumulated clock drift) and re-anchor.
    effect(() => {
      const status = this.control.status();
      const pb = status?.playback;
      const seqId = this.currentId();
      if (!pb || pb.mode !== 'sequence' || pb.sequence_id !== seqId) {
        if (untracked(() => this.playheadAnchor()) !== null) {
          this.playheadAnchor.set(null);
        }
        return;
      }
      const playing = status?.playing ?? false;
      const prev = untracked(() => this.playheadAnchor());
      const now = performance.now();
      // First anchor, or play/pause/seq change \u2192 anchor unconditionally.
      if (!prev || prev.playing !== playing) {
        this.playheadAnchor.set({ posMs: pb.position_ms, clockMs: now, playing });
        return;
      }
      // Steady-state: only resync on a clear divergence.
      const expected = playing
        ? prev.posMs + (now - prev.clockMs)
        : prev.posMs;
      if (Math.abs(pb.position_ms - expected) > PLAYHEAD_RESYNC_MS) {
        this.playheadAnchor.set({ posMs: pb.position_ms, clockMs: now, playing });
      }
    });

    // Range-loop watcher: when a play range is active and the engine's
    // playhead crosses the end marker, rewind it (and Spotify) to the start.
    effect(() => {
      const pos = this.playheadMs();
      const start = this.rangeStartMs();
      const end = this.rangeEndMs();
      if (pos === null || start === null || end === null) return;
      if (end <= start) return;
      if (pos < end) return;
      if (this.rangeResyncing) return;
      this.rangeResyncing = true;
      const snap = this.spotify.playerSnapshot();
      const spotifyActive = snap !== null && !snap.paused;
      const tasks: Promise<unknown>[] = [
        this.sequences.seek(start).catch(() => undefined),
      ];
      if (spotifyActive) {
        tasks.push(this.spotify.seek(start).catch(() => undefined));
      }
      Promise.all(tasks).finally(() => {
        this.rangeResyncing = false;
      });
    });
  }

  /** Mirror the editor's working copy so the footer can drive playback. */
  setCurrent(seq: Sequence | null): void {
    this.current.set(seq);
  }

  // ---------- transport ----------

  /**
   * Start the loaded sequence on the engine, persisting the latest edits
   * first. When the sequence is tied to a Spotify track, the song is started
   * in lock-step so music + lights play together, and the footer's
   * now-playing is updated to reflect it.
   */
  async play(): Promise<void> {
    const seq = this.current();
    if (!seq) return;
    try {
      await this.sequences.save(structuredClone(seq));
      // If a loop range is set, force loop on regardless of the checkbox so
      // the range watcher can keep rewinding the playhead.
      const looping = this.rangeActive() ? true : this.looping();
      await this.sequences.play(seq.id, looping);
      // Snap the engine to the range start so playback begins inside the
      // selected window. Without this, playback always starts at 0.
      const start = this.rangeStartMs();
      if (start !== null) {
        await this.sequences.seek(start);
      }
      // Drive Spotify alongside the sequencer when this sequence was built
      // from a Spotify track.
      const uri = this.spotifyTrackUri();
      if (uri && this.spotifyAuthed()) {
        try {
          const offset = start ?? 0;
          const snap = this.spotify.playerSnapshot();
          const trackId = uri.replace('spotify:track:', '');
          if (snap && snap.trackId === trackId) {
            await this.spotify.seek(offset);
            await this.spotify.resume();
          } else {
            await this.spotify.ensurePlaying(uri, offset);
          }
          // Reflect the playing track in the footer's now-playing block so
          // the music console and the show stay a single source of truth.
          this.spotify.selectedTrack.set({
            id: trackId,
            uri,
            name: seq.name,
            artists: '',
            duration_ms: seq.duration_ms,
          });
        } catch {
          // SpotifyService surfaces details in lastError; the sequencer
          // continues even if Spotify can't start.
        }
      }
      await this.control.loadStatus();
    } catch {
      // Error surfaced via the underlying service.
    }
  }

  /** Stop the show: leave sequence mode, halt the live engine, pause music. */
  async stop(): Promise<void> {
    try {
      await this.sequences.stop();
      await this.control.stop();
      if (this.spotifyTrackUri() && this.spotifyAuthed()) {
        await this.spotify.pause().catch(() => undefined);
      }
      await this.control.loadStatus();
    } catch {
      // ignored
    }
  }

  // ---------- range ----------

  clearRange(): void {
    this.rangeStartMs.set(null);
    this.rangeEndMs.set(null);
  }

  /** Seed a range over roughly the centre third of the sequence. */
  setRange(): void {
    const dur = this.durationMs();
    if (dur <= 0) return;
    this.rangeStartMs.set(Math.round(dur * 0.33));
    this.rangeEndMs.set(Math.round(dur * 0.66));
  }
}
