import { Injectable, inject, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';

import { Sequence } from './sequence.service';

const API_BASE = '/api';

export interface AudioAnalysis {
  duration_ms: number;
  sample_rate: number;
  bpm: number;
  beats_ms: number[];
  rms: number;
}

export interface AudioTrack {
  id: string;
  filename: string;
  analysis: AudioAnalysis;
}

/**
 * REST client for the Phase 4 audio upload + beat analysis + sequence
 * generation endpoints.
 */
@Injectable({ providedIn: 'root' })
export class AudioService {
  private readonly http = inject(HttpClient);

  readonly tracks = signal<AudioTrack[]>([]);
  readonly lastError = signal<string | null>(null);

  /** Upload a file and analyse it server-side. */
  async upload(file: File): Promise<AudioTrack> {
    return this.run(async () => {
      const form = new FormData();
      form.append('file', file, file.name);
      const track = await firstValueFrom(
        this.http.post<AudioTrack>(`${API_BASE}/audio/upload`, form),
      );
      await this.list();
      return track;
    });
  }

  async list(): Promise<AudioTrack[]> {
    return this.run(async () => {
      const items = await firstValueFrom(
        this.http.get<AudioTrack[]>(`${API_BASE}/audio`),
      );
      this.tracks.set(items);
      return items;
    });
  }

  async get(id: string): Promise<AudioTrack> {
    return this.run(() =>
      firstValueFrom(this.http.get<AudioTrack>(`${API_BASE}/audio/${id}`)),
    );
  }

  /** URL to stream the raw audio file (for the browser's <audio> element). */
  fileUrl(id: string): string {
    return `${API_BASE}/audio/${id}/file`;
  }

  /** Auto-generate a beat-synced sequence for this track. */
  async generate(id: string): Promise<Sequence> {
    return this.run(() =>
      firstValueFrom(
        this.http.post<Sequence>(`${API_BASE}/audio/${id}/generate`, {}),
      ),
    );
  }

  /** Generate (if needed) and start playing the beat-synced sequence. */
  async play(id: string): Promise<void> {
    return this.run(() =>
      firstValueFrom(
        this.http.post<void>(`${API_BASE}/audio/${id}/play`, {}),
      ),
    );
  }

  async delete(id: string): Promise<void> {
    await this.run(() =>
      firstValueFrom(this.http.delete<void>(`${API_BASE}/audio/${id}`)),
    );
    await this.list();
  }

  private async run<T>(fn: () => Promise<T>): Promise<T> {
    try {
      this.lastError.set(null);
      return await fn();
    } catch (err: unknown) {
      const msg =
        err instanceof Error ? err.message : 'Unknown error';
      this.lastError.set(msg);
      throw err;
    }
  }
}
