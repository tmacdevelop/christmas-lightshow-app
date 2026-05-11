import { Injectable, inject, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';

/**
 * Browser-mic onset detection. Opens a `getUserMedia` audio track, runs a
 * Web Audio `AnalyserNode` over it, and POSTs `/api/reactive/pulse` to the
 * backend each time it detects a beat-like onset in the low-mid energy
 * band.
 *
 * Algorithm (simple-but-works spectral-flux variant):
 * - 60 Hz analysis loop (`requestAnimationFrame`).
 * - Compute mean energy in the 60–250 Hz "kick" band from
 *   `getByteFrequencyData()`.
 * - Maintain a rolling moving-average of that energy (1 s window).
 * - Detect a pulse when the current energy exceeds `mean * threshold`
 *   AND the strip-min refractory window (default 140 ms) has passed.
 *
 * Pulse intensity sent to the server is `(current - mean) / mean`,
 * clamped to `[0, 1]`.
 *
 * Not perfect — won't catch every snare/hat — but it's enough to drive a
 * pleasing pulse-on-the-kick light show from any speaker output the
 * laptop mic can hear, including Spotify, vinyl, TV, etc.
 */
@Injectable({ providedIn: 'root' })
export class MicBeatService {
  private readonly http = inject(HttpClient);

  readonly running = signal(false);
  readonly currentEnergy = signal(0);
  readonly currentMean = signal(0);
  readonly lastBeatAt = signal<number | null>(null);
  readonly lastError = signal<string | null>(null);

  /** Sensitivity multiplier: pulse if current > mean * threshold. */
  readonly threshold = signal(1.6);
  /** Minimum gap between detected beats, ms. */
  readonly refractoryMs = signal(140);

  private ctx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private analyser: AnalyserNode | null = null;
  private rafId: number | null = null;
  private freqBuf: Uint8Array | null = null;
  private rollingMean = 0;
  private lastBeatTs = 0;

  async start(): Promise<void> {
    if (this.running()) return;
    this.lastError.set(null);
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        },
      });
      const Ctx =
        (window as unknown as { AudioContext: typeof AudioContext })
          .AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext })
          .webkitAudioContext;
      this.ctx = new Ctx();
      const source = this.ctx.createMediaStreamSource(this.stream);
      const analyser = this.ctx.createAnalyser();
      analyser.fftSize = 1024;
      analyser.smoothingTimeConstant = 0.2;
      source.connect(analyser);
      this.analyser = analyser;
      this.freqBuf = new Uint8Array(analyser.frequencyBinCount);
      this.rollingMean = 0;
      this.lastBeatTs = 0;
      this.running.set(true);
      this.loop();
    } catch (err) {
      this.lastError.set(this.errorMessage(err));
      await this.stop();
      throw err;
    }
  }

  async stop(): Promise<void> {
    this.running.set(false);
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    if (this.analyser) {
      this.analyser.disconnect();
      this.analyser = null;
    }
    if (this.ctx) {
      try {
        await this.ctx.close();
      } catch {
        /* ignore */
      }
      this.ctx = null;
    }
    if (this.stream) {
      for (const t of this.stream.getTracks()) t.stop();
      this.stream = null;
    }
    this.freqBuf = null;
  }

  private loop = (): void => {
    if (!this.running() || !this.analyser || !this.freqBuf || !this.ctx)
      return;
    this.analyser.getByteFrequencyData(this.freqBuf as unknown as Uint8Array<ArrayBuffer>);

    // Map 60..250 Hz to bin indices. bin = freq / (sampleRate / fftSize)
    const sr = this.ctx.sampleRate;
    const binHz = sr / this.analyser.fftSize;
    const lo = Math.max(1, Math.floor(60 / binHz));
    const hi = Math.min(this.freqBuf.length - 1, Math.ceil(250 / binHz));

    let sum = 0;
    for (let i = lo; i <= hi; i++) sum += this.freqBuf[i];
    const energy = sum / Math.max(1, hi - lo + 1) / 255; // 0..1

    // EMA with ~1s window at 60 fps -> alpha ≈ 1/60.
    const alpha = 1 / 60;
    this.rollingMean =
      this.rollingMean === 0
        ? energy
        : this.rollingMean * (1 - alpha) + energy * alpha;
    this.currentEnergy.set(energy);
    this.currentMean.set(this.rollingMean);

    const now = performance.now();
    const ratio = this.rollingMean > 0.005 ? energy / this.rollingMean : 0;
    const pastRefractory = now - this.lastBeatTs > this.refractoryMs();
    if (ratio > this.threshold() && pastRefractory && energy > 0.04) {
      this.lastBeatTs = now;
      this.lastBeatAt.set(now);
      // Strength: how far above the rolling mean we are, clamped.
      const strength = Math.min(1, (ratio - 1) / 1.5);
      void this.sendPulse(strength);
    }

    this.rafId = requestAnimationFrame(this.loop);
  };

  private async sendPulse(value: number): Promise<void> {
    try {
      await firstValueFrom(
        this.http.post<void>('/api/reactive/pulse', { value }),
      );
    } catch (err) {
      // Don't spam logs — only record the last failure.
      this.lastError.set(this.errorMessage(err));
    }
  }

  private errorMessage(err: unknown): string {
    if (err instanceof Error) return err.message;
    return String(err);
  }
}
