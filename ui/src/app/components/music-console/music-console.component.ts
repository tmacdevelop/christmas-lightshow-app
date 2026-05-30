import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  signal,
} from '@angular/core';
import { DecimalPipe } from '@angular/common';

import { SpotifyService } from '../../services/spotify.service';
import { SequencerTransportService } from '../../services/sequencer-transport.service';
import { NowPlayingService } from '../../services/now-playing.service';

/**
 * Persistent transport bar for music + light-show playback. Pinned to the
 * bottom of the workspace shell so the user can control everything from any
 * tab. Two stacked rows:
 *
 *   Row 1: now-playing info · seek bar · volume
 *   Row 2: unified transport (restart · play/pause · stop) · show indicator
 *          · Loop · Range
 *
 * The single Play button is the only transport for both music and lights:
 *  - When a sequence is loaded, it drives `SequencerTransportService.play()`
 *    which starts the lights AND the music together.
 *  - When only a Spotify track is selected, it toggles Spotify play/pause.
 */
@Component({
  selector: 'app-music-console',
  standalone: true,
  imports: [DecimalPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    class:
      'fixed bottom-0 left-0 right-0 z-30 flex h-24 shrink-0 flex-col gap-1 border-t border-zinc-800 bg-zinc-950/95 px-4 py-2 backdrop-blur',
  },
  templateUrl: './music-console.component.html',
})
export class MusicConsoleComponent {
  private readonly spotify = inject(SpotifyService);
  private readonly transport = inject(SequencerTransportService);
  private readonly nowPlaying = inject(NowPlayingService);

  protected readonly loadedSource = this.nowPlaying.loaded;
  /**
   * Track shown in the now-playing block. Mirrors the *loaded* source — a
   * Spotify highlight in the panel does NOT appear here. The shape matches
   * the legacy {@link SelectedTrack} so the template stays unchanged.
   */
  protected readonly selectedTrack = computed(() => {
    const ld = this.loadedSource();
    if (!ld) return null;
    const uri = ld.source.kind === 'spotify' ? ld.source.uri : '';
    return {
      id: ld.source.trackId,
      uri,
      name: ld.name,
      artists: ld.artists,
      duration_ms: ld.durationMs,
      cover: ld.cover,
    };
  });
  protected readonly snapshot = this.spotify.playerSnapshot;
  protected readonly livePlayHeadMs = this.spotify.livePlayHeadMs;

  /**
   * Local override for the seek bar's displayed value while the user is
   * dragging the thumb. `null` ⇒ track {@link livePlayHeadMs}. We commit
   * the seek (network call) only on release, but the thumb still has to
   * follow the cursor while dragging — that's what this signal does.
   */
  protected readonly scrubValueMs = signal<number | null>(null);
  /** Seek-bar value: scrub override if dragging, else live playhead. */
  protected readonly seekDisplayMs = computed(() => {
    const scrub = this.scrubValueMs();
    if (scrub != null) return scrub;
    return this.selectionIsLoaded() ? this.livePlayHeadMs() : 0;
  });
  protected readonly volume = this.spotify.volume;
  protected readonly muted = this.spotify.muted;
  protected readonly playerReady = this.spotify.playerReady;

  // ---- Light-show transport (shared with the Timeline editor) ----
  protected readonly showName = this.transport.currentName;
  protected readonly showLoaded = computed(
    () => this.transport.current() !== null,
  );
  protected readonly showPlaying = this.transport.isPlaying;
  protected readonly looping = this.transport.looping;
  protected readonly rangeActive = this.transport.rangeActive;
  protected readonly rangeStartMs = this.transport.rangeStartMs;
  protected readonly rangeEndMs = this.transport.rangeEndMs;

  /** True when the currently selected track is the one loaded in the SDK. */
  protected readonly selectionIsLoaded = computed(() => {
    const sel = this.selectedTrack();
    const snap = this.snapshot();
    return !!sel && !!snap && snap.trackId === sel.id;
  });

  /** Duration shown by the console: live snapshot if loaded, else selection. */
  protected readonly consoleDurationMs = computed(() => {
    if (this.selectionIsLoaded()) return this.snapshot()?.duration_ms ?? 0;
    return this.selectedTrack()?.duration_ms ?? 0;
  });

  /** Something the unified Play button can act on. */
  protected readonly canPlay = computed(
    () => this.showLoaded() || this.selectedTrack() !== null,
  );

  /** True when the Spotify SDK is actively playing the loaded track. */
  protected readonly musicPlaying = computed(() => {
    const snap = this.snapshot();
    return !!snap && !snap.paused && this.selectionIsLoaded();
  });

  /**
   * What the transport considers "currently playing" for label purposes.
   * Music takes priority so pausing/resuming the song flips the icon even
   * while the engine is still in sequence mode in the background.
   */
  protected readonly isPlaying = computed(
    () => this.musicPlaying() || (this.showPlaying() && !this.selectedTrack()),
  );

  /**
   * Unified Play/Pause. If a sequence is loaded, drive the show transport
   * (which handles both lights and music). Otherwise just toggle Spotify.
   */
  protected async playPause(): Promise<void> {
    if (this.showLoaded()) {
      if (this.musicPlaying()) {
        // Pause music; leave sequence mode active so resume continues
        // from the same playhead. Use Stop to fully tear down.
        await this.spotify.pause().catch(() => undefined);
        return;
      }
      // If the engine is already in sequence mode for this show, just
      // resume the music — `transport.play()` would re-issue a fresh
      // playback request that briefly snaps the playhead to 0.
      if (this.showPlaying() && this.selectionIsLoaded()) {
        await this.spotify.resume().catch(() => undefined);
        return;
      }
      await this.transport.play();
      return;
    }
    const sel = this.selectedTrack();
    if (!sel) return;
    // Uploads (and any non-Spotify source) carry an empty URI — there's
    // nothing for the SDK to play. The Music tab owns its own playback.
    if (!sel.uri) return;
    if (this.selectionIsLoaded()) {
      await this.spotify.togglePlay().catch(() => undefined);
      return;
    }
    try {
      await this.spotify.ensurePlaying(sel.uri);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.spotify.lastError.set(`Play failed: ${msg}`);
    }
  }

  protected async restart(): Promise<void> {
    if (this.showLoaded()) {
      // Re-call transport.play() to restart lights + music from the start
      // (or the range start if a range is active).
      await this.transport.play();
      return;
    }
    await this.spotify.restart().catch(() => undefined);
  }

  /** Stop everything: leaves sequence mode and pauses the music. */
  protected async stopAll(): Promise<void> {
    if (this.showPlaying()) {
      await this.transport.stop();
      return;
    }
    await this.spotify.pause().catch(() => undefined);
  }

  protected async toggleMute(): Promise<void> {
    await this.spotify.toggleMute().catch(() => undefined);
  }

  protected onVolumeInput(value: number): void {
    this.spotify.setVolume(value).catch(() => undefined);
  }

  /** Pointer is dragging the thumb — update display only, no network. */
  protected onSeekScrub(positionMs: number): void {
    this.scrubValueMs.set(positionMs);
  }

  /** Pointer released (or keyboard committed) — actually seek. */
  protected onSeekCommit(positionMs: number): void {
    this.scrubValueMs.set(null);
    this.spotify.seek(positionMs).catch(() => undefined);
  }

  protected onLoopingChange(value: boolean): void {
    this.looping.set(value);
  }

  protected toggleRange(): void {
    if (this.rangeActive()) {
      this.transport.clearRange();
    } else {
      this.transport.setRange();
    }
  }

  protected formatDuration(ms: number): string {
    if (!Number.isFinite(ms) || ms <= 0) return '0:00';
    const total = Math.round(ms / 1000);
    const m = Math.floor(total / 60);
    const s = total % 60;
    return `${m}:${String(s).padStart(2, '0')}`;
  }
}
