import { Injectable, inject, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';

import { EffectKind, ShowStatus } from './show-control.service';

export interface ClipColor {
  r: number;
  g: number;
  b: number;
}

export interface Clip {
  id: string;
  start_ms: number;
  duration_ms: number;
  kind: EffectKind;
  color: ClipColor;
}

export interface Sequence {
  id: string;
  name: string;
  duration_ms: number;
  clips: Clip[];
}

const API_BASE = '/api';

/**
 * REST client for the Phase 3 sequence library + playback control.
 *
 * Maintains the loaded sequence list as a signal so multiple components can
 * subscribe to library changes after a save/delete round-trip.
 */
@Injectable({ providedIn: 'root' })
export class SequenceService {
  private readonly http = inject(HttpClient);

  readonly sequences = signal<Sequence[]>([]);
  readonly lastError = signal<string | null>(null);

  async list(): Promise<Sequence[]> {
    return this.run(async () => {
      const items = await firstValueFrom(
        this.http.get<Sequence[]>(`${API_BASE}/sequences`),
      );
      this.sequences.set(items);
      return items;
    });
  }

  async get(id: string): Promise<Sequence> {
    return this.run(() =>
      firstValueFrom(this.http.get<Sequence>(`${API_BASE}/sequences/${id}`)),
    );
  }

  async save(seq: Sequence): Promise<Sequence> {
    const saved = await this.run(() =>
      firstValueFrom(
        this.http.put<Sequence>(`${API_BASE}/sequences/${seq.id}`, seq),
      ),
    );
    // Refresh list so callers see ordering / inserts.
    await this.list();
    return saved;
  }

  async delete(id: string): Promise<void> {
    await this.run(() =>
      firstValueFrom(
        this.http.delete<void>(`${API_BASE}/sequences/${id}`),
      ),
    );
    await this.list();
  }

  /** Start playing a sequence on the engine. Returns updated show status. */
  async play(id: string, looping: boolean): Promise<ShowStatus> {
    return this.run(() =>
      firstValueFrom(
        this.http.post<ShowStatus>(`${API_BASE}/sequences/${id}/play`, {
          loop: looping,
        }),
      ),
    );
  }

  /** Stop sequence playback (engine returns to live mode). */
  async stop(): Promise<ShowStatus> {
    return this.run(() =>
      firstValueFrom(
        this.http.post<ShowStatus>(`${API_BASE}/playback/stop`, {}),
      ),
    );
  }

  private async run<T>(action: () => Promise<T>): Promise<T> {
    try {
      const value = await action();
      this.lastError.set(null);
      return value;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.lastError.set(msg);
      throw err;
    }
  }
}
