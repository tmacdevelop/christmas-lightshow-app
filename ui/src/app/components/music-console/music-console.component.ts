import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
} from '@angular/core';
import { DecimalPipe } from '@angular/common';

import { SpotifyService } from '../../services/spotify.service';

/**
 * Persistent transport bar for Spotify playback. Lives as a fixed footer in
 * the workspace shell so the user can control the loaded song from any tab.
 *
 * All state is read from the `SpotifyService` singleton, so it survives tab
 * switches and stays in sync with the Spotify panel's selection.
 */
@Component({
  selector: 'app-music-console',
  standalone: true,
  imports: [DecimalPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    class:
      'fixed bottom-0 left-0 right-0 z-30 flex h-16 shrink-0 items-center gap-4 border-t border-zinc-800 bg-zinc-950/95 px-4 py-2 backdrop-blur',
  },
  templateUrl: './music-console.component.html',
})
export class MusicConsoleComponent {
  private readonly spotify = inject(SpotifyService);

  protected readonly selectedTrack = this.spotify.selectedTrack;
  protected readonly snapshot = this.spotify.playerSnapshot;
  protected readonly livePlayHeadMs = this.spotify.livePlayHeadMs;
  protected readonly volume = this.spotify.volume;
  protected readonly muted = this.spotify.muted;
  protected readonly playerReady = this.spotify.playerReady;

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

  /**
   * Primary transport button. If the selected track is already loaded in the
   * SDK, toggle play/pause. Otherwise load the selection and start it.
   */
  protected async playPause(): Promise<void> {
    const sel = this.selectedTrack();
    if (!sel) return;
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
    await this.spotify.restart().catch(() => undefined);
  }

  protected async stopPlayback(): Promise<void> {
    await this.spotify.pause().catch(() => undefined);
  }

  protected async toggleMute(): Promise<void> {
    await this.spotify.toggleMute().catch(() => undefined);
  }

  protected onVolumeInput(value: number): void {
    this.spotify.setVolume(value).catch(() => undefined);
  }

  protected onSeekInput(positionMs: number): void {
    this.spotify.seek(positionMs).catch(() => undefined);
  }

  protected formatDuration(ms: number): string {
    if (!Number.isFinite(ms) || ms <= 0) return '0:00';
    const total = Math.round(ms / 1000);
    const m = Math.floor(total / 60);
    const s = total % 60;
    return `${m}:${String(s).padStart(2, '0')}`;
  }
}
