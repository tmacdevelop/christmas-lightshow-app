import { Injectable, inject } from '@angular/core';

import { ShowControlService } from './show-control.service';
import { ShowStatus } from '../models/show.models';

const STATUS_WS_URL = '/ws/status';

/** Minimum delay before the first reconnect attempt (ms). */
const RECONNECT_BASE_MS = 1_000;
/** Maximum delay between reconnect attempts (ms). */
const RECONNECT_MAX_MS = 30_000;

/**
 * Connects to the `/ws/status` WebSocket and pushes every JSON status message
 * it receives into {@link ShowControlService.status}. This replaces the
 * per-component polling loops that previously called `/api/status` repeatedly.
 *
 * The service is `providedIn: 'root'` and auto-starts in its constructor, so
 * injecting it anywhere (e.g. in WorkspaceComponent) is enough to activate it.
 * Reconnects automatically with exponential backoff on unexpected disconnects.
 */
@Injectable({ providedIn: 'root' })
export class StatusSocketService {
  private readonly control = inject(ShowControlService);

  private socket: WebSocket | null = null;
  private reconnectDelay = RECONNECT_BASE_MS;
  private destroyed = false;

  constructor() {
    this.connect();
  }

  /** Permanently stop the service (call on application teardown if needed). */
  destroy(): void {
    this.destroyed = true;
    this.socket?.close();
    this.socket = null;
  }

  private connect(): void {
    if (this.destroyed) return;

    const url = this.resolveUrl(STATUS_WS_URL);
    const ws = new WebSocket(url);
    this.socket = ws;

    ws.addEventListener('open', () => {
      this.reconnectDelay = RECONNECT_BASE_MS;
    });

    ws.addEventListener('message', (event: MessageEvent) => {
      if (typeof event.data !== 'string') return;
      try {
        const status = JSON.parse(event.data) as ShowStatus;
        this.control.status.set(status);
      } catch {
        // Malformed message — ignore.
      }
    });

    ws.addEventListener('close', () => {
      this.socket = null;
      this.scheduleReconnect();
    });

    ws.addEventListener('error', () => {
      // 'close' always fires after 'error', so reconnect is handled there.
    });
  }

  private scheduleReconnect(): void {
    if (this.destroyed) return;
    setTimeout(() => this.connect(), this.reconnectDelay);
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, RECONNECT_MAX_MS);
  }

  /**
   * Convert a path like `/ws/status` to an absolute `ws://` or `wss://` URL
   * so the service works regardless of which origin the Angular dev server
   * proxies from.
   */
  private resolveUrl(path: string): string {
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${protocol}//${location.host}${path}`;
  }
}
