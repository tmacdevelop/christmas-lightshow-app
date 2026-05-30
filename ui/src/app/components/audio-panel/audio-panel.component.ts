import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  OnDestroy,
  OnInit,
  ViewChild,
  computed,
  inject,
  signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { DecimalPipe } from '@angular/common';

import { AudioService } from '../../services/audio.service';
import { NowPlayingService } from '../../services/now-playing.service';
import { AudioTrack } from '../../models/audio.models';
import { LxButton } from '../../ui-components/button/lx-button';

@Component({
  selector: 'app-audio-panel',
  standalone: true,
  imports: [FormsModule, LxButton, DecimalPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './audio-panel.component.html',
})
export class AudioPanelComponent implements OnInit, OnDestroy {
  protected readonly audioService = inject(AudioService);
  private readonly nowPlaying = inject(NowPlayingService);

  protected readonly tracks = this.audioService.tracks;
  protected readonly lastError = this.audioService.lastError;
  protected readonly loadedSource = this.nowPlaying.loaded;

  protected readonly uploading = signal(false);
  protected readonly generating = signal(false);
  protected readonly loadingId = signal<string | null>(null);
  protected readonly dragging = signal(false);
  protected readonly playing = signal(false);
  protected readonly selectedId = signal<string | null>(null);
  protected readonly currentTime = signal(0);
  protected readonly duration = signal(0);

  @ViewChild('audioEl') private audioRef?: ElementRef<HTMLAudioElement>;
  @ViewChild('waveCanvas') private canvasRef?: ElementRef<HTMLCanvasElement>;

  /** Currently selected track (derived). */
  protected readonly selectedTrack = computed(() =>
    this.tracks().find((t) => t.id === this.selectedId()) ?? null,
  );

  async ngOnInit(): Promise<void> {
    await this.audioService.list();
  }

  ngOnDestroy(): void {
    this.audioRef?.nativeElement.pause();
  }

  // ── Upload ──────────────────────────────────────────────────────────────

  onDragOver(e: DragEvent): void {
    e.preventDefault();
    this.dragging.set(true);
  }

  async onDrop(e: DragEvent): Promise<void> {
    e.preventDefault();
    this.dragging.set(false);
    const file = e.dataTransfer?.files[0];
    if (file) await this.upload(file);
  }

  async onFileChange(e: Event): Promise<void> {
    const file = (e.target as HTMLInputElement).files?.[0];
    if (file) await this.upload(file);
  }

  private async upload(file: File): Promise<void> {
    this.uploading.set(true);
    try {
      const track = await this.audioService.upload(file);
      this.selectTrack(track);
    } catch {
      // error shown via lastError signal
    } finally {
      this.uploading.set(false);
    }
  }

  // ── Track selection ──────────────────────────────────────────────────────

  selectTrack(track: AudioTrack): void {
    this.playing.set(false);
    this.audioRef?.nativeElement.pause();
    this.currentTime.set(0);
    this.selectedId.set(track.id);
    // Draw waveform on next tick (after view update resolves the canvas ref).
    setTimeout(() => this.drawWaveform(track), 0);
  }

  // ── Waveform ─────────────────────────────────────────────────────────────

  private drawWaveform(track: AudioTrack): void {
    const canvas = this.canvasRef?.nativeElement;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const W = canvas.clientWidth;
    const H = canvas.clientHeight;
    canvas.width = W;
    canvas.height = H;

    const beats = track.analysis.beats_ms;
    const totalMs = track.analysis.duration_ms;

    // Background.
    ctx.fillStyle = '#18181b';
    ctx.fillRect(0, 0, W, H);

    // Beat markers.
    ctx.fillStyle = 'rgba(34,197,94,0.35)';
    for (const ms of beats) {
      const x = Math.round((ms / totalMs) * W);
      ctx.fillRect(x, 0, 1, H);
    }

    // Simple amplitude envelope (sine-based placeholder until we pipe
    // actual waveform data from the server).
    ctx.strokeStyle = '#6ee7b7';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let px = 0; px < W; px++) {
      const t = px / W;
      // Progress-aware noise approximation.
      const amp = 0.35 + 0.25 * Math.abs(Math.sin(t * Math.PI));
      const noise = Math.sin(t * 512 + 1.2) * Math.sin(t * 317 + 2.5);
      const y = H / 2 + (H / 2) * amp * noise;
      if (px === 0) ctx.moveTo(px, y);
      else ctx.lineTo(px, y);
    }
    ctx.stroke();
  }

  // ── Playback ─────────────────────────────────────────────────────────────

  togglePlay(): void {
    const el = this.audioRef?.nativeElement;
    if (!el) return;
    if (this.playing()) {
      el.pause();
      this.playing.set(false);
    } else {
      this.duration.set(el.duration || 0);
      el.play().catch(() => {});
      this.playing.set(true);
    }
  }

  onTimeUpdate(e: Event): void {
    const el = e.target as HTMLAudioElement;
    this.currentTime.set(el.currentTime);
    this.duration.set(el.duration || 0);
  }

  /** Start browser audio + server beat-synced sequence simultaneously. */
  async syncPlay(id: string): Promise<void> {
    try {
      // Start server sequence first (small network latency negligible).
      await this.audioService.play(id);
      // Then play browser audio.
      const el = this.audioRef?.nativeElement;
      if (el) {
        el.currentTime = 0;
        await el.play();
        this.playing.set(true);
      }
    } catch {
      // error shown via lastError signal
    }
  }

  async generate(id: string): Promise<void> {
    this.generating.set(true);
    try {
      await this.audioService.generate(id);
    } catch {
      // error shown via lastError signal
    } finally {
      this.generating.set(false);
    }
  }

  /** Load an upload into the unified player (no auto-play). */
  async loadIntoPlayer(track: AudioTrack): Promise<void> {
    this.loadingId.set(track.id);
    try {
      await this.nowPlaying.loadUpload(track);
    } catch {
      // error surfaced via lastError
    } finally {
      this.loadingId.set(null);
    }
  }

  protected isLoaded(track: AudioTrack): boolean {
    const ld = this.loadedSource();
    return ld?.source.kind === 'upload' && ld.source.trackId === track.id;
  }

  async deleteTrack(id: string): Promise<void> {
    if (this.selectedId() === id) {
      this.selectedId.set(null);
      this.playing.set(false);
      this.audioRef?.nativeElement.pause();
    }
    await this.audioService.delete(id);
  }

  // ── Formatting ───────────────────────────────────────────────────────────

  formatDuration(ms: number): string {
    const totalSec = Math.floor(ms / 1000);
    const m = Math.floor(totalSec / 60);
    const s = totalSec % 60;
    return `${m}:${s.toString().padStart(2, '0')}`;
  }
}
