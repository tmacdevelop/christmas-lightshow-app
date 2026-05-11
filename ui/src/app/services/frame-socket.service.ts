import { Injectable, signal } from '@angular/core';

export type { ConnectionState, DecodedFrame } from '../models/socket.models';
import type { ConnectionState, DecodedFrame } from '../models/socket.models';

interface FrameStats {
  framesPerSecond: number;
  bytesPerSecond: number;
  totalFrames: number;
}

/**
 * Streams binary RGB frames from the backend WebSocket at `/ws`.
 *
 * Each binary message is `pixel_count * 3` bytes: `[r, g, b, r, g, b, ...]`.
 * Subscribers register a callback via {@link onFrame}; signals expose
 * connection state and live FPS / throughput stats.
 */
@Injectable({ providedIn: 'root' })
export class FrameSocketService {
  readonly state = signal<ConnectionState>('idle');
  readonly stats = signal<FrameStats>({
    framesPerSecond: 0,
    bytesPerSecond: 0,
    totalFrames: 0,
  });
  readonly lastError = signal<string | null>(null);

  private socket: WebSocket | null = null;
  private frameHandler: ((frame: DecodedFrame) => void) | null = null;

  // Rolling window for FPS / bps measurements (1s window, recomputed every frame).
  private windowStart = 0;
  private windowFrames = 0;
  private windowBytes = 0;
  private totalFrames = 0;

  /** Register the per-frame callback. Replaces any prior handler. */
  onFrame(handler: (frame: DecodedFrame) => void): void {
    this.frameHandler = handler;
  }

  connect(url: string): void {
    this.disconnect();
    this.lastError.set(null);
    this.state.set('connecting');
    this.resetStats();

    let socket: WebSocket;
    try {
      socket = new WebSocket(url);
    } catch (err) {
      this.state.set('error');
      this.lastError.set((err as Error).message);
      return;
    }
    socket.binaryType = 'arraybuffer';

    socket.addEventListener('open', () => this.state.set('open'));
    socket.addEventListener('message', (event) => this.handleMessage(event));
    socket.addEventListener('error', () => {
      this.state.set('error');
      this.lastError.set('WebSocket error');
    });
    socket.addEventListener('close', () => {
      if (this.state() !== 'error') {
        this.state.set('closed');
      }
    });

    this.socket = socket;
  }

  disconnect(): void {
    if (this.socket) {
      this.socket.close();
      this.socket = null;
    }
    this.state.set('idle');
  }

  private handleMessage(event: MessageEvent): void {
    if (!(event.data instanceof ArrayBuffer)) {
      // Phase 1 only consumes binary frames. Ignore JSON / text in this client.
      return;
    }
    const bytes = new Uint8Array(event.data);
    this.frameHandler?.(bytes);

    // Stats: frames-per-second + bytes-per-second over a 1-second sliding window.
    const now = performance.now();
    if (this.windowStart === 0) {
      this.windowStart = now;
    }
    this.windowFrames += 1;
    this.windowBytes += bytes.byteLength;
    this.totalFrames += 1;

    const elapsed = now - this.windowStart;
    if (elapsed >= 1000) {
      const seconds = elapsed / 1000;
      this.stats.set({
        framesPerSecond: Math.round(this.windowFrames / seconds),
        bytesPerSecond: Math.round(this.windowBytes / seconds),
        totalFrames: this.totalFrames,
      });
      this.windowStart = now;
      this.windowFrames = 0;
      this.windowBytes = 0;
    }
  }

  private resetStats(): void {
    this.windowStart = 0;
    this.windowFrames = 0;
    this.windowBytes = 0;
    this.totalFrames = 0;
    this.stats.set({ framesPerSecond: 0, bytesPerSecond: 0, totalFrames: 0 });
  }
}
