import { Injectable, inject, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';

export type EffectKind = 'solid' | 'fade' | 'chase' | 'rainbow';

export type PlaybackMode = 'live' | 'sequence';

export interface EffectInfo {
  kind: EffectKind;
  uses_color: boolean;
}

export interface ColorPayload {
  r: number;
  g: number;
  b: number;
  hex: string;
}

export interface PlaybackInfo {
  mode: PlaybackMode;
  sequence_id: string | null;
  sequence_name: string | null;
  position_ms: number;
  duration_ms: number;
  looping: boolean;
}

export interface ShowStatus {
  playing: boolean;
  brightness: number;
  color: ColorPayload;
  effect: EffectKind;
  playback: PlaybackInfo;
}

export interface EffectsResponse {
  available: EffectInfo[];
  active: EffectKind;
}

const API_BASE = '/api';

/**
 * Thin REST client for the Phase 2 control plane.
 *
 * Holds the latest server status in a signal so components can read it
 * reactively after `refresh()` or any mutating call.
 */
@Injectable({ providedIn: 'root' })
export class ShowControlService {
  private readonly http = inject(HttpClient);

  readonly status = signal<ShowStatus | null>(null);
  readonly effects = signal<EffectInfo[]>([]);
  readonly lastError = signal<string | null>(null);

  async refresh(): Promise<void> {
    await Promise.all([this.loadStatus(), this.loadEffects()]);
  }

  async loadStatus(): Promise<void> {
    await this.run(async () => {
      const status = await firstValueFrom(
        this.http.get<ShowStatus>(`${API_BASE}/status`),
      );
      this.status.set(status);
    });
  }

  async loadEffects(): Promise<void> {
    await this.run(async () => {
      const res = await firstValueFrom(
        this.http.get<EffectsResponse>(`${API_BASE}/effects`),
      );
      this.effects.set(res.available);
    });
  }

  start(): Promise<void> {
    return this.post('/start');
  }

  stop(): Promise<void> {
    return this.post('/stop');
  }

  setEffect(kind: EffectKind): Promise<void> {
    return this.post('/effect', { kind });
  }

  setColorHex(hex: string): Promise<void> {
    return this.post('/color', { hex });
  }

  setColorRgb(r: number, g: number, b: number): Promise<void> {
    return this.post('/color', { r, g, b });
  }

  setBrightness(value: number): Promise<void> {
    return this.post('/brightness', { value });
  }

  private async post(path: string, body: unknown = {}): Promise<void> {
    await this.run(async () => {
      const status = await firstValueFrom(
        this.http.post<ShowStatus>(`${API_BASE}${path}`, body),
      );
      this.status.set(status);
    });
  }

  private async run(action: () => Promise<void>): Promise<void> {
    try {
      await action();
      this.lastError.set(null);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.lastError.set(msg);
    }
  }
}
