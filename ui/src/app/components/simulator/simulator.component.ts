import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  computed,
  effect,
  inject,
  input,
  signal,
  viewChild,
  AfterViewInit,
  OnDestroy,
} from '@angular/core';
import { FormsModule } from '@angular/forms';

import { FrameSocketService } from '../../services/frame-socket.service';
import { LayoutService } from '../../services/layout.service';
import { ShowControlService } from '../../services/show-control.service';
import { Layout } from '../../models/layout.models';
import { SimulatorVariant } from '../../models/simulator.models';

export type { SimulatorVariant } from '../../models/simulator.models';

const DEFAULT_WS_URL = '/ws';

@Component({
  selector: 'app-simulator',
  standalone: true,
  imports: [FormsModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './simulator.component.html',
  styleUrl: './simulator.component.css',
})
export class SimulatorComponent implements AfterViewInit, OnDestroy {
  private readonly socket = inject(FrameSocketService);
  private readonly control = inject(ShowControlService);
  private readonly layouts = inject(LayoutService);

  protected readonly canvasRef = viewChild.required<ElementRef<HTMLCanvasElement>>('canvas');

  /** 'popout' hides chrome so the canvas fills the window. */
  readonly variant = input<SimulatorVariant>('embedded');

  protected readonly url = signal(DEFAULT_WS_URL);
  protected readonly state = this.socket.state;
  protected readonly stats = this.socket.stats;
  protected readonly lastError = this.socket.lastError;

  /** Active layout the simulator is rendering against, or null = legacy strip. */
  private readonly activeLayout = signal<Layout | null>(null);
  /** Id we last fetched, so we don't refetch on every status poll. */
  private lastFetchedActiveId: string | null = null;

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

    // Track the active layout id from server status and lazily fetch the
    // layout details whenever it changes.
    effect(() => {
      const id = this.control.status()?.active_layout_id ?? null;
      if (id !== this.lastFetchedActiveId) {
        this.lastFetchedActiveId = id;
        if (id) {
          this.layouts
            .get(id)
            .then((l) => this.activeLayout.set(l))
            .catch(() => this.activeLayout.set(null));
        } else {
          this.activeLayout.set(null);
        }
      }
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

  /** Open a new window showing only the simulator, filling the viewport. */
  protected popOut(): void {
    const url = new URL(window.location.href);
    url.searchParams.set('view', 'simulator');
    url.hash = '';
    const features = 'width=900,height=600,menubar=no,toolbar=no,location=no';
    window.open(url.toString(), 'lightshow-simulator', features);
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

    const layout = this.activeLayout();
    if (layout && layout.props.length > 0) {
      this.drawLayout(ctx, cssWidth, cssHeight, frame, layout);
    } else {
      this.drawFlatStrip(ctx, cssWidth, cssHeight, frame);
    }
  }

  /** Legacy renderer: a single horizontal row of dots. */
  private drawFlatStrip(
    ctx: CanvasRenderingContext2D,
    cssWidth: number,
    cssHeight: number,
    frame: Uint8Array,
  ): void {
    const pixelCount = Math.floor(frame.length / 3);
    if (pixelCount === 0) return;

    const padding = 32;
    const usableWidth = Math.max(1, cssWidth - padding * 2);
    const spacing = usableWidth / pixelCount;
    const dotRadius = Math.max(3, Math.min(spacing * 0.45, 18));
    const cy = cssHeight / 2;

    for (let i = 0; i < pixelCount; i += 1) {
      const cx = padding + spacing * (i + 0.5);
      this.drawDot(ctx, cx, cy, dotRadius, frame, i);
    }
  }

  /** Layout-aware renderer: each prop's pixels are placed along its strip. */
  private drawLayout(
    ctx: CanvasRenderingContext2D,
    cssWidth: number,
    cssHeight: number,
    frame: Uint8Array,
  layout: Layout,
  ): void {
    const padding = 24;
    const usableW = Math.max(1, cssWidth - padding * 2);
    const usableH = Math.max(1, cssHeight - padding * 2);
    // Letterbox the layout into the canvas, preserving aspect ratio.
    const scale = Math.min(usableW / layout.width, usableH / layout.height);
    const drawW = layout.width * scale;
    const drawH = layout.height * scale;
    const offX = (cssWidth - drawW) / 2;
    const offY = (cssHeight - drawH) / 2;

    // Faint canvas border so the user sees the room bounds.
    ctx.strokeStyle = '#27272a';
    ctx.lineWidth = 1;
    ctx.strokeRect(offX, offY, drawW, drawH);

    const totalPixels = Math.floor(frame.length / 3);

    for (const prop of layout.props) {
      if (prop.geometry.type !== 'strip') continue;
      const start = prop.geometry.start;
      const end = prop.geometry.end;

      const segLen = Math.hypot(end.x - start.x, end.y - start.y) * scale;
      // Clamp dot radius so even short props get visible dots, but not so big
      // they overlap heavily on long ones.
      const spacing = prop.pixel_count > 0 ? segLen / prop.pixel_count : 0;
      const dotRadius = Math.max(2.5, Math.min(spacing * 0.45, 12));

      for (let i = 0; i < prop.pixel_count; i += 1) {
        // Wrap pixel offsets that exceed the engine's frame buffer so layouts
        // with many strips still render even when the global pixel_count is
        // smaller than the layout's total pixel demand.
        const idx = (prop.pixel_offset + i) % totalPixels;
        // Center each pixel inside its 1/N segment so endpoints aren't doubled.
        const t =
          prop.pixel_count === 1 ? 0.5 : (i + 0.5) / prop.pixel_count;
        const lx = start.x + (end.x - start.x) * t;
        const ly = start.y + (end.y - start.y) * t;
        const cx = offX + lx * scale;
        const cy = offY + ly * scale;
        this.drawDot(ctx, cx, cy, dotRadius, frame, idx);
      }
    }
  }

  private drawDot(
    ctx: CanvasRenderingContext2D,
    cx: number,
    cy: number,
    dotRadius: number,
    frame: Uint8Array,
    pixelIndex: number,
  ): void {
    const r = frame[pixelIndex * 3];
    const g = frame[pixelIndex * 3 + 1];
    const b = frame[pixelIndex * 3 + 2];

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
