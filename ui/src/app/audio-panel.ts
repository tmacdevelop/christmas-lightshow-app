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

import { AudioService, AudioTrack } from './audio.service';
import { LxButton } from './ui/button/lx-button';

@Component({
  selector: 'app-audio-panel',
  standalone: true,
  imports: [FormsModule, LxButton, DecimalPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <!-- Drop zone / upload -->
    <div
      class="mb-4 flex flex-col items-center justify-center rounded-lg border-2 border-dashed border-zinc-600 p-6 transition-colors"
      [class.border-green-500]="dragging()"
      (dragover)="onDragOver($event)"
      (dragleave)="dragging.set(false)"
      (drop)="onDrop($event)"
    >
      @if (uploading()) {
        <p class="text-sm text-zinc-400">Analysing audio…</p>
        <div class="mt-2 h-1.5 w-40 overflow-hidden rounded bg-zinc-700">
          <div class="h-full animate-pulse rounded bg-green-500 w-full"></div>
        </div>
      } @else {
        <p class="mb-2 text-sm text-zinc-400">
          Drop an MP3 / WAV / OGG / FLAC here, or
        </p>
        <button lx-button size="sm" (click)="fileInput.click()">Browse…</button>
        <input
          #fileInput
          type="file"
          accept="audio/*"
          class="hidden"
          (change)="onFileChange($event)"
        />
      }
    </div>

    @if (lastError()) {
      <p class="mb-3 rounded bg-red-900/40 px-3 py-2 text-xs text-red-300">
        {{ lastError() }}
      </p>
    }

    <!-- Track list -->
    @if (tracks().length === 0) {
      <p class="text-center text-xs text-zinc-500">No audio uploaded yet.</p>
    } @else {
      <ul class="space-y-2">
        @for (track of tracks(); track track.id) {
          <li
            class="rounded-lg bg-zinc-800 p-3"
            [class.ring-2]="selectedId() === track.id"
            [class.ring-green-500]="selectedId() === track.id"
          >
            <!-- Track header -->
            <div class="flex items-start justify-between gap-2">
              <button
                class="min-w-0 flex-1 text-left"
                (click)="selectTrack(track)"
              >
                <p class="truncate text-sm font-medium text-zinc-100">
                  {{ track.filename }}
                </p>
                <p class="mt-0.5 text-xs text-zinc-400">
                  {{ formatDuration(track.analysis.duration_ms) }} ·
                  {{ track.analysis.bpm | number: '1.0-1' }} BPM ·
                  {{ track.analysis.beats_ms.length }} beats
                </p>
              </button>
              <button
                class="shrink-0 text-zinc-500 hover:text-red-400 text-xs"
                title="Delete"
                (click)="deleteTrack(track.id)"
              >✕</button>
            </div>

            <!-- Expanded view for selected track -->
            @if (selectedId() === track.id) {
              <!-- Waveform canvas -->
              <canvas
                #waveCanvas
                class="mt-3 h-16 w-full rounded bg-zinc-900"
              ></canvas>

              <!-- Playback controls -->
              <div class="mt-3 flex items-center gap-2">
                <audio
                  #audioEl
                  [src]="audioService.fileUrl(track.id)"
                  (timeupdate)="onTimeUpdate($event)"
                  (ended)="playing.set(false)"
                ></audio>

                <button
                  lx-button
                  size="sm"
                  [variant]="playing() ? 'danger' : 'primary'"
                  (click)="togglePlay()"
                >
                  {{ playing() ? '⏹ Stop' : '▶ Play Audio' }}
                </button>

                <button
                  lx-button
                  size="sm"
                  variant="secondary"
                  [disabled]="generating()"
                  (click)="generate(track.id)"
                >
                  {{ generating() ? 'Generating…' : '✨ Auto-generate' }}
                </button>

                <button
                  lx-button
                  size="sm"
                  variant="success"
                  (click)="syncPlay(track.id)"
                >
                  ▶ Sync Lights
                </button>
              </div>

              <!-- Playhead progress bar -->
              @if (duration() > 0) {
                <div class="mt-2 h-1 w-full overflow-hidden rounded bg-zinc-700">
                  <div
                    class="h-full rounded bg-green-500 transition-all"
                    [style.width.%]="(currentTime() / duration()) * 100"
                  ></div>
                </div>
                <p class="mt-1 text-right text-xs text-zinc-500">
                  {{ formatDuration(currentTime() * 1000) }} /
                  {{ formatDuration(duration() * 1000) }}
                </p>
              }
            }
          </li>
        }
      </ul>
    }
  `,
})
export class AudioPanelComponent implements OnInit, OnDestroy {
  protected readonly audioService = inject(AudioService);

  protected readonly tracks = this.audioService.tracks;
  protected readonly lastError = this.audioService.lastError;

  protected readonly uploading = signal(false);
  protected readonly generating = signal(false);
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
