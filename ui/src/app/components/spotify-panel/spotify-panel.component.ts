import {
  ChangeDetectionStrategy,
  Component,
  OnInit,
  computed,
  inject,
  signal,
} from '@angular/core';
import { DecimalPipe, NgTemplateOutlet } from '@angular/common';
import { FormsModule } from '@angular/forms';

import { SpotifyService } from '../../services/spotify.service';
import { SpotifyAlbumTrack, SpotifySavedAlbum, SpotifyTrack } from '../../models/spotify.models';
import { SequenceService } from '../../services/sequence.service';
import { NowPlayingService } from '../../services/now-playing.service';
import { LxButton } from '../../ui-components/button/lx-button';
import { LxTab, LxTabs } from '../../ui-components/tabs/lx-tabs';

/** A row that can be sent to `generateAndPlay`. */
interface Playable {
  id: string;
  uri: string;
  name: string;
  artists: { name: string }[];
  duration_ms: number;
  /** Optional cover image URL (album art). */
  cover?: string;
  /** Optional secondary line (release year, album name, etc.). */
  meta?: string;
}

/**
 * Spotify panel: login, search, library browsing (Liked Songs + Saved
 * Albums), and "generate light show from Spotify analysis" — wired into
 * the existing sequence engine so the resulting sequence plays on the
 * simulator like any other show.
 */
@Component({
  selector: 'app-spotify-panel',
  standalone: true,
  imports: [FormsModule, DecimalPipe, LxButton, LxTabs, LxTab, NgTemplateOutlet],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'flex h-full min-h-0 flex-col' },
  templateUrl: './spotify-panel.component.html',
})
export class SpotifyPanelComponent implements OnInit {
  private readonly spotify = inject(SpotifyService);
  private readonly sequences = inject(SequenceService);
  private readonly nowPlaying = inject(NowPlayingService);

  protected readonly status = this.spotify.status;
  protected readonly results = this.spotify.searchResults;
  protected readonly lastError = this.spotify.lastError;
  protected readonly busy = this.spotify.busy;
  /** Local row highlight — distinct from what's *loaded* into the player. */
  protected readonly highlightedId = signal<string | null>(null);
  protected readonly loadedSource = this.nowPlaying.loaded;

  protected query = '';
  protected readonly hasSearched = signal(false);
  protected readonly generatingId = signal<string | null>(null);
  protected readonly loadingId = signal<string | null>(null);
  protected readonly lastBuild = signal<{
    sequence_id: string;
    clip_count: number;
    duration_ms: number;
  } | null>(null);
  protected readonly justAuthed = signal(false);

  // Library state
  protected readonly libraryTracks = signal<SpotifyTrack[]>([]);
  protected readonly libraryTracksLoaded = signal(false);
  protected readonly libraryTracksTotal = signal(0);

  protected readonly libraryAlbums = signal<SpotifySavedAlbum[]>([]);
  protected readonly libraryAlbumsLoaded = signal(false);
  protected readonly libraryAlbumsTotal = signal(0);

  /** When set, the Albums tab shows this album's track listing instead of the grid. */
  protected readonly selectedAlbum = signal<SpotifySavedAlbum | null>(null);
  protected readonly selectedAlbumTracks = signal<SpotifyAlbumTrack[]>([]);
  protected readonly selectedAlbumLoading = signal(false);

  protected readonly avatarUrl = computed(() => {
    const imgs = this.status().user?.images ?? [];
    return imgs.length > 0 ? imgs[0]!.url : '';
  });

  async ngOnInit(): Promise<void> {
    if (typeof window !== 'undefined') {
      const params = new URLSearchParams(window.location.search);
      const flag = params.get('spotify');
      if (flag === 'ok') {
        this.justAuthed.set(true);
        params.delete('spotify');
        params.delete('reason');
        const qs = params.toString();
        const cleaned = window.location.pathname + (qs ? `?${qs}` : '');
        window.history.replaceState({}, '', cleaned);
      } else if (flag === 'error') {
        const reason = params.get('reason') ?? 'unknown';
        this.spotify.lastError.set(`Spotify login failed: ${reason}`);
      }
    }
    await this.spotify.refreshStatus().catch(() => undefined);
  }

  async login(): Promise<void> {
    await this.spotify.login().catch(() => undefined);
  }

  async logout(): Promise<void> {
    await this.spotify.logout().catch(() => undefined);
  }

  async onSearch(event: Event): Promise<void> {
    event.preventDefault();
    this.hasSearched.set(true);
    await this.spotify.search(this.query).catch(() => undefined);
  }

  async ensureLibraryTracks(): Promise<void> {
    if (this.libraryTracksLoaded() || !this.status().authenticated) return;
    try {
      const page = await this.spotify.libraryTracks(50, 0);
      this.libraryTracks.set(page.items.map((i) => i.track));
      this.libraryTracksTotal.set(page.total);
      this.libraryTracksLoaded.set(true);
    } catch {
      /* lastError already set */
    }
  }

  async loadMoreLibraryTracks(): Promise<void> {
    const offset = this.libraryTracks().length;
    if (offset >= this.libraryTracksTotal()) return;
    try {
      const page = await this.spotify.libraryTracks(50, offset);
      this.libraryTracks.set([
        ...this.libraryTracks(),
        ...page.items.map((i) => i.track),
      ]);
    } catch {
      /* noop */
    }
  }

  async ensureLibraryAlbums(): Promise<void> {
    if (this.libraryAlbumsLoaded() || !this.status().authenticated) return;
    try {
      const page = await this.spotify.libraryAlbums(50, 0);
      this.libraryAlbums.set(page.items.map((i) => i.album));
      this.libraryAlbumsTotal.set(page.total);
      this.libraryAlbumsLoaded.set(true);
    } catch {
      /* noop */
    }
  }

  async loadMoreLibraryAlbums(): Promise<void> {
    const offset = this.libraryAlbums().length;
    if (offset >= this.libraryAlbumsTotal()) return;
    try {
      const page = await this.spotify.libraryAlbums(50, offset);
      this.libraryAlbums.set([
        ...this.libraryAlbums(),
        ...page.items.map((i) => i.album),
      ]);
    } catch {
      /* noop */
    }
  }

  protected onTabChange(index: number): void {
    // Tab order: 0 = Search, 1 = Liked Songs, 2 = Albums.
    if (index === 1) void this.ensureLibraryTracks();
    if (index === 2) void this.ensureLibraryAlbums();
  }

  async openAlbum(album: SpotifySavedAlbum): Promise<void> {
    this.selectedAlbum.set(album);
    if (album.tracks?.items?.length) {
      this.selectedAlbumTracks.set(album.tracks.items);
      return;
    }
    this.selectedAlbumLoading.set(true);
    try {
      const page = await this.spotify.albumTracks(album.id, 50, 0);
      this.selectedAlbumTracks.set(page.items);
    } catch {
      this.selectedAlbumTracks.set([]);
    } finally {
      this.selectedAlbumLoading.set(false);
    }
  }

  protected closeAlbum(): void {
    this.selectedAlbum.set(null);
    this.selectedAlbumTracks.set([]);
  }

  // Playable helpers
  protected toPlayable(t: SpotifyTrack): Playable {
    return {
      id: t.id,
      uri: t.uri,
      name: t.name,
      artists: t.artists,
      duration_ms: t.duration_ms,
      cover: this.albumArt(t),
      meta: t.album?.name ?? undefined,
    };
  }

  protected toPlayableFromAlbumTrack(
    t: SpotifyAlbumTrack,
    album: SpotifySavedAlbum,
  ): Playable {
    const trackNum =
      t.disc_number > 1 ? `${t.disc_number}.${t.track_number}` : `${t.track_number}`;
    return {
      id: t.id,
      uri: t.uri,
      name: t.name,
      artists: t.artists,
      duration_ms: t.duration_ms,
      cover: this.albumImage(album),
      meta: trackNum,
    };
  }

  async generateAndPlay(p: Playable): Promise<void> {
    this.generatingId.set(p.id);
    try {
      // Route through NowPlayingService so the footer reflects the loaded
      // track (and the badge updates) before playback begins.
      const result = await this.nowPlaying.loadSpotify({
        id: p.id,
        uri: p.uri,
        name: p.name,
        artists: this.artistNames(p),
        duration_ms: p.duration_ms,
        cover: p.cover,
      });
      if (result.sequenceId) {
        this.lastBuild.set({
          sequence_id: result.sequenceId,
          clip_count: 0,
          duration_ms: p.duration_ms,
        });
        await this.sequences.list().catch(() => undefined);
        await this.sequences
          .play(result.sequenceId, false)
          .catch(() => undefined);
      } else if (result.error) {
        this.spotify.lastError.set(
          `Loaded for music-only playback (no light show): ${result.error}`,
        );
      }
      try {
        await this.spotify.initPlayer();
        await this.waitForDevice();
        await this.spotify.playUri(p.uri);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.spotify.lastError.set(
          `Synced playback unavailable (${msg}). Light show is still playing on the simulator.`,
        );
      }
    } catch {
      /* lastError already set */
    } finally {
      this.generatingId.set(null);
    }
  }

  /**
   * Highlight a row in the panel. Selection is purely a local UI hint — it
   * does *not* touch the footer Music Console. To make a track appear in
   * the footer the user must press "Load" (or "Sync Lights").
   */
  protected select(p: Playable): void {
    this.highlightedId.set(p.id);
  }

  protected isSelected(p: Playable): boolean {
    return this.highlightedId() === p.id;
  }

  /**
   * Load a track into the unified player without auto-playing. Generates
   * the light-show sequence (or proceeds without one if Deezer has no
   * BPM); either way the track lands in the footer Music Console where
   * the user can press Play.
   */
  async loadIntoPlayer(p: Playable): Promise<void> {
    this.loadingId.set(p.id);
    try {
      const result = await this.nowPlaying.loadSpotify({
        id: p.id,
        uri: p.uri,
        name: p.name,
        artists: this.artistNames(p),
        duration_ms: p.duration_ms,
        cover: p.cover,
      });
      if (!result.sequenceId && result.error) {
        // Track is still loaded for music-only playback; surface the
        // analysis failure so the user knows lights won't be in sync.
        this.spotify.lastError.set(
          `Loaded for music-only playback (no light show): ${result.error}`,
        );
      } else {
        await this.sequences.list().catch(() => undefined);
      }
    } finally {
      this.loadingId.set(null);
    }
  }

  protected isLoaded(p: Playable): boolean {
    const ld = this.loadedSource();
    return ld?.source.kind === 'spotify' && ld.source.trackId === p.id;
  }

  private async waitForDevice(timeoutMs = 5000): Promise<void> {
    const start = performance.now();
    while (performance.now() - start < timeoutMs) {
      if (this.spotify.deviceId()) return;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error('SDK device did not become ready');
  }

  protected artistNames(t: { artists: { name: string }[] }): string {
    return t.artists.map((a) => a.name).join(', ');
  }

  protected albumArt(t: SpotifyTrack): string {
    return this.pickImage(t.album?.images ?? []);
  }

  protected albumImage(a: SpotifySavedAlbum): string {
    return this.pickImage(a.images);
  }

  private pickImage(
    imgs: { url: string; width?: number; height?: number }[],
  ): string {
    if (imgs.length === 0) return '';
    const sorted = [...imgs].sort(
      (a, b) => (a.width ?? 0) - (b.width ?? 0),
    );
    const pick =
      sorted.find((i) => (i.width ?? 0) >= 64) ?? sorted[sorted.length - 1];
    return pick?.url ?? '';
  }

  protected formatDuration(ms: number): string {
    if (!Number.isFinite(ms) || ms <= 0) return '—';
    const total = Math.round(ms / 1000);
    const m = Math.floor(total / 60);
    const s = total % 60;
    return `${m}:${String(s).padStart(2, '0')}`;
  }
}
