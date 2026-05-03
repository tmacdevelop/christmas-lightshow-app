import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  HostListener,
  OnDestroy,
  OnInit,
  computed,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { FormsModule } from '@angular/forms';

import { Clip, Sequence, SequenceService } from './sequence.service';
import {
  EffectKind,
  ShowControlService,
} from './show-control.service';

const DEFAULT_DURATION_MS = 10_000;
const DEFAULT_CLIP_DURATION_MS = 1_000;
const MIN_CLIP_MS = 50;
const POLL_INTERVAL_MS = 200;
const RESIZE_HANDLE_PX = 8;

type DragKind = 'move' | 'resize-end';

interface DragState {
  clipId: string;
  kind: DragKind;
  pointerId: number;
  startClientX: number;
  origStartMs: number;
  origDurationMs: number;
}

let nextLocalId = 1;
function makeId(prefix: string): string {
  // Browser-compatible enough; collision is fine — server validates.
  const rand = Math.random().toString(36).slice(2, 8);
  return `${prefix}-${Date.now().toString(36)}-${(nextLocalId++).toString(
    36,
  )}-${rand}`;
}

function rgbToHex({ r, g, b }: { r: number; g: number; b: number }): string {
  const c = (n: number) =>
    Math.max(0, Math.min(255, Math.round(n)))
      .toString(16)
      .padStart(2, '0');
  return `#${c(r)}${c(g)}${c(b)}`;
}

function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const v = m[1];
  return {
    r: parseInt(v.slice(0, 2), 16),
    g: parseInt(v.slice(2, 4), 16),
    b: parseInt(v.slice(4, 6), 16),
  };
}

@Component({
  selector: 'app-timeline',
  standalone: true,
  imports: [FormsModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './timeline.html',
  styleUrl: './timeline.css',
})
export class TimelineComponent implements OnInit, OnDestroy {
  private readonly sequences = inject(SequenceService);
  private readonly control = inject(ShowControlService);

  protected readonly track =
    viewChild.required<ElementRef<HTMLDivElement>>('track');

  protected readonly library = this.sequences.sequences;
  protected readonly lastError = this.sequences.lastError;
  protected readonly status = this.control.status;

  protected readonly editing = signal<Sequence | null>(null);
  protected readonly selectedClipId = signal<string | null>(null);
  protected readonly looping = signal<boolean>(true);

  protected readonly effectKinds: EffectKind[] = [
    'solid',
    'fade',
    'chase',
    'rainbow',
  ];

  protected readonly editingId = computed(() => this.editing()?.id ?? null);
  protected readonly clips = computed(() => this.editing()?.clips ?? []);
  protected readonly durationMs = computed(
    () => this.editing()?.duration_ms ?? 0,
  );
  protected readonly selectedClip = computed<Clip | null>(() => {
    const id = this.selectedClipId();
    if (!id) return null;
    return this.editing()?.clips.find((c) => c.id === id) ?? null;
  });
  protected readonly selectedColorHex = computed(() => {
    const c = this.selectedClip();
    return c ? rgbToHex(c.color) : '#ff0000';
  });

  /** Live playhead position in ms from the show status (sequence mode only). */
  protected readonly playheadMs = computed(() => {
    const pb = this.status()?.playback;
    if (!pb || pb.mode !== 'sequence') return null;
    if (pb.sequence_id !== this.editingId()) return null;
    return pb.position_ms;
  });
  protected readonly isPlayingThis = computed(() => this.playheadMs() !== null);

  private dragState: DragState | null = null;
  private pollHandle: number | null = null;

  async ngOnInit(): Promise<void> {
    await this.sequences.list();
    if (this.library().length > 0) {
      await this.loadSequence(this.library()[0].id);
    }

    // Light polling so the playhead and live controls stay in sync.
    this.pollHandle = window.setInterval(() => {
      this.control.loadStatus().catch(() => undefined);
    }, POLL_INTERVAL_MS);
  }

  ngOnDestroy(): void {
    if (this.pollHandle !== null) {
      window.clearInterval(this.pollHandle);
      this.pollHandle = null;
    }
  }

  // ---------- library actions ----------

  protected async loadSequence(id: string): Promise<void> {
    if (!id) {
      this.editing.set(null);
      this.selectedClipId.set(null);
      return;
    }
    try {
      const seq = await this.sequences.get(id);
      this.editing.set(seq);
      this.selectedClipId.set(null);
    } catch {
      // Error already surfaced via service.
    }
  }

  protected newSequence(): void {
    const seq: Sequence = {
      id: makeId('seq'),
      name: 'New Sequence',
      duration_ms: DEFAULT_DURATION_MS,
      clips: [],
    };
    this.editing.set(seq);
    this.selectedClipId.set(null);
  }

  protected async saveSequence(): Promise<void> {
    const seq = this.editing();
    if (!seq) return;
    try {
      const saved = await this.sequences.save(structuredClone(seq));
      this.editing.set(saved);
    } catch {
      // Error surfaced via service.
    }
  }

  protected async deleteSequence(): Promise<void> {
    const seq = this.editing();
    if (!seq) return;
    if (!confirm(`Delete sequence "${seq.name}"?`)) return;
    try {
      await this.sequences.delete(seq.id);
      this.editing.set(null);
      this.selectedClipId.set(null);
    } catch {
      // ignored
    }
  }

  protected async play(): Promise<void> {
    const seq = this.editing();
    if (!seq) return;
    // Persist before playing so server has the latest version.
    try {
      await this.sequences.save(structuredClone(seq));
      await this.sequences.play(seq.id, this.looping());
      await this.control.loadStatus();
    } catch {
      // ignored
    }
  }

  protected async stop(): Promise<void> {
    try {
      await this.sequences.stop();
      await this.control.loadStatus();
    } catch {
      // ignored
    }
  }

  // ---------- editing ----------

  protected onNameChange(value: string): void {
    const seq = this.editing();
    if (!seq) return;
    this.editing.set({ ...seq, name: value });
  }

  protected onDurationChange(value: number): void {
    const seq = this.editing();
    if (!seq || !Number.isFinite(value) || value <= 0) return;
    this.editing.set({ ...seq, duration_ms: Math.round(value) });
  }

  protected onLoopingChange(value: boolean): void {
    this.looping.set(value);
  }

  /** Click on empty timeline space → add a clip. */
  protected onTrackClick(event: MouseEvent): void {
    if (this.dragState) return;
    if (event.target instanceof HTMLElement && event.target.dataset['clip']) {
      // Click landed on a clip; let its handler manage selection.
      return;
    }
    const seq = this.editing();
    if (!seq) return;

    const t = this.clientXToMs(event.clientX);
    if (t === null) return;
    const status = this.status();
    const color = status
      ? { r: status.color.r, g: status.color.g, b: status.color.b }
      : { r: 255, g: 0, b: 0 };
    const kind: EffectKind = status?.effect ?? 'solid';

    const clip: Clip = {
      id: makeId('clip'),
      start_ms: Math.max(
        0,
        Math.min(t, Math.max(0, seq.duration_ms - DEFAULT_CLIP_DURATION_MS)),
      ),
      duration_ms: Math.min(DEFAULT_CLIP_DURATION_MS, seq.duration_ms),
      kind,
      color,
    };
    this.editing.set({ ...seq, clips: [...seq.clips, clip] });
    this.selectedClipId.set(clip.id);
  }

  protected selectClip(id: string, event: MouseEvent): void {
    event.stopPropagation();
    this.selectedClipId.set(id);
  }

  protected deleteSelectedClip(): void {
    const seq = this.editing();
    const id = this.selectedClipId();
    if (!seq || !id) return;
    this.editing.set({
      ...seq,
      clips: seq.clips.filter((c) => c.id !== id),
    });
    this.selectedClipId.set(null);
  }

  protected onClipFieldChange<K extends keyof Clip>(
    field: K,
    value: Clip[K],
  ): void {
    const seq = this.editing();
    const id = this.selectedClipId();
    if (!seq || !id) return;
    this.editing.set({
      ...seq,
      clips: seq.clips.map((c) => (c.id === id ? { ...c, [field]: value } : c)),
    });
  }

  protected onClipColorHex(hex: string): void {
    const rgb = hexToRgb(hex);
    if (!rgb) return;
    this.onClipFieldChange('color', rgb);
  }

  // ---------- drag / resize ----------

  protected onClipPointerDown(
    event: PointerEvent,
    clipId: string,
    kind: DragKind,
  ): void {
    const seq = this.editing();
    if (!seq) return;
    const clip = seq.clips.find((c) => c.id === clipId);
    if (!clip) return;
    event.preventDefault();
    event.stopPropagation();
    (event.target as Element).setPointerCapture?.(event.pointerId);
    this.selectedClipId.set(clipId);
    this.dragState = {
      clipId,
      kind,
      pointerId: event.pointerId,
      startClientX: event.clientX,
      origStartMs: clip.start_ms,
      origDurationMs: clip.duration_ms,
    };
  }

  @HostListener('window:pointermove', ['$event'])
  onPointerMove(event: PointerEvent): void {
    const drag = this.dragState;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const seq = this.editing();
    if (!seq) return;

    const trackEl = this.track().nativeElement;
    const rect = trackEl.getBoundingClientRect();
    if (rect.width <= 0 || seq.duration_ms <= 0) return;

    const dxPx = event.clientX - drag.startClientX;
    const dxMs = (dxPx / rect.width) * seq.duration_ms;

    const updated = seq.clips.map((c) => {
      if (c.id !== drag.clipId) return c;
      if (drag.kind === 'move') {
        const minStart = 0;
        const maxStart = Math.max(0, seq.duration_ms - drag.origDurationMs);
        const startMs = Math.round(
          Math.max(minStart, Math.min(maxStart, drag.origStartMs + dxMs)),
        );
        return { ...c, start_ms: startMs };
      }
      // resize-end: keep start, change duration
      const maxDur = seq.duration_ms - drag.origStartMs;
      const durationMs = Math.round(
        Math.max(MIN_CLIP_MS, Math.min(maxDur, drag.origDurationMs + dxMs)),
      );
      return { ...c, duration_ms: durationMs };
    });
    this.editing.set({ ...seq, clips: updated });
  }

  @HostListener('window:pointerup', ['$event'])
  onPointerUp(event: PointerEvent): void {
    if (!this.dragState || this.dragState.pointerId !== event.pointerId) return;
    this.dragState = null;
  }

  // ---------- helpers ----------

  protected clipLeftPct(clip: Clip): number {
    const dur = this.durationMs();
    if (dur <= 0) return 0;
    return (clip.start_ms / dur) * 100;
  }

  protected clipWidthPct(clip: Clip): number {
    const dur = this.durationMs();
    if (dur <= 0) return 0;
    return (clip.duration_ms / dur) * 100;
  }

  protected playheadPct(): number {
    const dur = this.durationMs();
    const pos = this.playheadMs();
    if (dur <= 0 || pos === null) return 0;
    return (Math.min(pos, dur) / dur) * 100;
  }

  protected clipColorCss(clip: Clip): string {
    return `rgb(${clip.color.r}, ${clip.color.g}, ${clip.color.b})`;
  }

  /** Resolve a clientX coordinate to a timeline position in milliseconds. */
  private clientXToMs(clientX: number): number | null {
    const seq = this.editing();
    if (!seq || seq.duration_ms <= 0) return null;
    const rect = this.track().nativeElement.getBoundingClientRect();
    if (rect.width <= 0) return null;
    const ratio = (clientX - rect.left) / rect.width;
    return Math.round(Math.max(0, Math.min(1, ratio)) * seq.duration_ms);
  }

  protected isResizeHandle(event: MouseEvent, el: HTMLElement): boolean {
    const rect = el.getBoundingClientRect();
    return event.clientX >= rect.right - RESIZE_HANDLE_PX;
  }
}
