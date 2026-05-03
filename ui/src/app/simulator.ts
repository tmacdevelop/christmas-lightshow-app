import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  computed,
  effect,
  inject,
  signal,
  viewChild,
  AfterViewInit,
  OnDestroy,
} from '@angular/core';
import { FormsModule } from '@angular/forms';

import { FrameSocketService } from './frame-socket.service';

const DEFAULT_WS_URL = '/ws';

@Component({
  selector: 'app-simulator',
  standalone: true,
  imports: [FormsModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './simulator.html',
  styleUrl: './simulator.css',
})
export class SimulatorComponent implements AfterViewInit, OnDestroy {
  private readonly socket = inject(FrameSocketService);

  protected readonly canvasRef = viewChild.required<ElementRef<HTMLCanvasElement>>('canvas');

  protected readonly url = signal(DEFAULT_WS_URL);
  protected readonly state = this.socket.state;
  protected readonly stats = this.socket.stats;
  protected readonly lastError = this.socket.lastError;

  protected readonly statusLabel = computed(() => {
    switch (this.state()) {
      case 'open':
        return 'Connected';
      case 'connecting':
        return 'Connecting…';
      case 'closed':
        return 'Disconnected';
      case 'error':
        return 'Error';
      default:
        return 'Idle';
    }
  });

  protected readonly statusClass = computed(() => {
    switch (this.state()) {
      case 'open':
        return 'bg-emerald-500';
      case 'connecting':
        return 'bg-amber-400 animate-pulse';
      case 'error':
        return 'bg-red-500';
      default:
        return 'bg-zinc-500';
    }
  });

  private latestFrame: Uint8Array | null = null;
  private rafHandle: number | null = null;

  constructor() {
    this.socket.onFrame((frame) => {
      this.latestFrame = frame;
    });

    // Auto-disconnect on destroy via the host's lifecycle (OnDestroy).
    effect(() => {
      // Trigger redraws when state changes (e.g. paint a "disconnected" hint).
      this.state();
    });
  }

  ngAfterViewInit(): void {
    this.connect();
    this.startRenderLoop();
  }

  ngOnDestroy(): void {
    if (this.rafHandle !== null) {
      cancelAnimationFrame(this.rafHandle);
    }
    this.socket.disconnect();
  }

  protected connect(): void {
    let target = this.url().trim();
    if (!target) {
      return;
    }
    // Allow relative URLs by resolving against the current page.
    if (target.startsWith('/')) {
      const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      target = `${proto}//${window.location.host}${target}`;
    }
    this.socket.connect(target);
  }

  protected disconnect(): void {
    this.socket.disconnect();
  }

  private startRenderLoop(): void {
    const canvas = this.canvasRef().nativeElement;
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) {
      return;
    }

    const tick = () => {
      this.draw(canvas, ctx);
      this.rafHandle = requestAnimationFrame(tick);
    };
    this.rafHandle = requestAnimationFrame(tick);
  }

  private draw(canvas: HTMLCanvasElement, ctx: CanvasRenderingContext2D): void {
    // Resize to match CSS pixels (DPR-aware) so dots stay crisp on high-DPI screens.
    const dpr = window.devicePixelRatio || 1;
    const cssWidth = canvas.clientWidth;
    const cssHeight = canvas.clientHeight;
    const pixelWidth = Math.max(1, Math.floor(cssWidth * dpr));
    const pixelHeight = Math.max(1, Math.floor(cssHeight * dpr));
    if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
      canvas.width = pixelWidth;
      canvas.height = pixelHeight;
    }

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#0a0a0a';
    ctx.fillRect(0, 0, cssWidth, cssHeight);

    const frame = this.latestFrame;
    if (!frame || frame.length < 3) {
      return;
    }

    const pixelCount = Math.floor(frame.length / 3);
    if (pixelCount === 0) {
      return;
    }

    // Lay pixels out as a horizontal strip with a glowing dot per pixel.
    const padding = 32;
    const usableWidth = Math.max(1, cssWidth - padding * 2);
    const spacing = usableWidth / pixelCount;
    const dotRadius = Math.max(3, Math.min(spacing * 0.45, 18));
    const cy = cssHeight / 2;

    for (let i = 0; i < pixelCount; i += 1) {
      const r = frame[i * 3];
      const g = frame[i * 3 + 1];
      const b = frame[i * 3 + 2];
      const cx = padding + spacing * (i + 0.5);

      // Soft outer glow.
      const glow = ctx.createRadialGradient(cx, cy, 0, cx, cy, dotRadius * 3);
      glow.addColorStop(0, `rgba(${r}, ${g}, ${b}, 0.55)`);
      glow.addColorStop(1, 'rgba(0, 0, 0, 0)');
      ctx.fillStyle = glow;
      ctx.beginPath();
      ctx.arc(cx, cy, dotRadius * 3, 0, Math.PI * 2);
      ctx.fill();

      // Bright core.
      ctx.fillStyle = `rgb(${r}, ${g}, ${b})`;
      ctx.beginPath();
      ctx.arc(cx, cy, dotRadius, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}
