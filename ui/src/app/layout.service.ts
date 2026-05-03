import { Injectable, inject, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';

import { ShowStatus } from './show-control.service';

export interface Point {
  x: number;
  y: number;
}

/**
 * Discriminated union of geometries. Phase 3 only ships `strip` (a straight
 * line of evenly spaced pixels), but new variants slot in as additional
 * `type` values.
 */
export type Geometry = StripGeometry;

export interface StripGeometry {
  type: 'strip';
  start: Point;
  end: Point;
}

export interface Prop {
  id: string;
  name: string;
  pixel_offset: number;
  pixel_count: number;
  geometry: Geometry;
}

export interface Layout {
  id: string;
  name: string;
  width: number;
  height: number;
  props: Prop[];
}

const API_BASE = '/api';

/** REST client for the Phase 3 layout designer. */
@Injectable({ providedIn: 'root' })
export class LayoutService {
  private readonly http = inject(HttpClient);

  readonly layouts = signal<Layout[]>([]);
  readonly lastError = signal<string | null>(null);

  async list(): Promise<Layout[]> {
    return this.run(async () => {
      const items = await firstValueFrom(
        this.http.get<Layout[]>(`${API_BASE}/layouts`),
      );
      this.layouts.set(items);
      return items;
    });
  }

  async get(id: string): Promise<Layout> {
    return this.run(() =>
      firstValueFrom(this.http.get<Layout>(`${API_BASE}/layouts/${id}`)),
    );
  }

  async save(layout: Layout): Promise<Layout> {
    const saved = await this.run(() =>
      firstValueFrom(
        this.http.put<Layout>(`${API_BASE}/layouts/${layout.id}`, layout),
      ),
    );
    await this.list();
    return saved;
  }

  async delete(id: string): Promise<void> {
    await this.run(() =>
      firstValueFrom(this.http.delete<void>(`${API_BASE}/layouts/${id}`)),
    );
    await this.list();
  }

  async activate(id: string): Promise<ShowStatus> {
    return this.run(() =>
      firstValueFrom(
        this.http.post<ShowStatus>(`${API_BASE}/layouts/${id}/activate`, {}),
      ),
    );
  }

  async deactivate(): Promise<ShowStatus> {
    return this.run(() =>
      firstValueFrom(
        this.http.post<ShowStatus>(`${API_BASE}/layouts/deactivate`, {}),
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
