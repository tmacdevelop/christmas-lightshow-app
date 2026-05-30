import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  HostListener,
  OnInit,
  computed,
  effect,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { FormsModule } from '@angular/forms';

import { SequenceService } from '../../services/sequence.service';
import { Clip, ClipColor, Sequence } from '../../models/sequence.models';
import { ShowControlService } from '../../services/show-control.service';
import { EffectKind } from '../../models/show.models';
import { SequencerTransportService } from '../../services/sequencer-transport.service';
import { SpotifyService } from '../../services/spotify.service';
import {
  LxConfirmModal,
  LxModalController,
} from '../../ui-components';

const DEFAULT_DURATION_MS = 10_000;
const DEFAULT_CLIP_DURATION_MS = 1_000;
const MIN_CLIP_MS = 50;
const RESIZE_HANDLE_PX = 8;

type DragKind = 'move' | 'resize-end' | 'range-start' | 'range-end' | 'range-band';

interface DragState {
  clipId: string;
  kind: DragKind;
  pointerId: number;
  startClientX: number;
  origStartMs: number;
  origDurationMs: number;
  /** For 'range-band': original range start/end at pointer-down. */
  origRangeStartMs?: number;
  origRangeEndMs?: number;
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
  imports: [FormsModule, LxConfirmModal],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './timeline.component.html',
  styleUrl: './timeline.component.css',
})
export class TimelineComponent implements OnInit {
  private readonly sequences = inject(SequenceService);
  private readonly control = inject(ShowControlService);
  private readonly transport = inject(SequencerTransportService);
  private readonly spotify = inject(SpotifyService);

  protected readonly track =
    viewChild.required<ElementRef<HTMLDivElement>>('track');
  /** Optional ref to the live playhead `<div>` so a rAF loop can move it
   * directly without triggering Angular change detection. */
  protected readonly playheadEl =
    viewChild<ElementRef<HTMLDivElement>>('playheadEl');
  /** Optional ref to the playhead-ms text node, also driven by rAF so it
   * doesn't share CD ticks with the zoom/height range inputs. */
  protected readonly playheadMsLabel =
    viewChild<ElementRef<HTMLSpanElement>>('playheadMsLabel');

  protected readonly library = this.sequences.sequences;
  protected readonly lastError = this.sequences.lastError;
  protected readonly status = this.control.status;

  protected readonly editing = signal<Sequence | null>(null);
  protected readonly selectedClipId = signal<string | null>(null);
  /** Confirm-delete modal controller. Owns open state + payload. */
  protected readonly deletePrompt = new LxModalController<{
    id: string;
    name: string;
  }>();

  /** Vertical track height in px (zoom). */
  protected readonly trackHeightPx = signal<number>(96);
  /** Horizontal zoom multiplier. 1 = fit, larger values widen the track. */
  protected readonly zoomX = signal<number>(1);
  /** When true, clicking a pixel cell turns it off (black) instead of painting. */
  protected readonly eraseMode = signal<boolean>(false);
  /**
   * When false, clicks on empty timeline space are ignored (no new clips).
   * Toggled by the "Edit" button so users can scrub/inspect without
   * accidentally adding clips.
   */
  protected readonly editMode = signal<boolean>(false);

  /** Playback range — when non-null, Play loops between these markers.
   * Owned by the transport service so the footer transport stays in sync. */
  protected readonly rangeStartMs = this.transport.rangeStartMs;
  protected readonly rangeEndMs = this.transport.rangeEndMs;
  protected readonly rangeActive = this.transport.rangeActive;

  protected readonly effectKinds: EffectKind[] = [
    'solid',
    'fade',
    'chase',
    'rainbow',
    'reactive',
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
  protected readonly playheadMs = this.transport.playheadMs;
  protected readonly isPlayingThis = this.transport.isPlaying;
  private rafHandle: number | null = null;

  private dragState: DragState | null = null;

  constructor() {
    // Keep the transport service's working copy mirrored to the editor so the
    // footer Play/Stop transport always acts on the latest edits.
    effect(() => {
      this.transport.setCurrent(this.editing());
    });

    // Smoothly animate the playhead `<div>` directly via rAF so the red
    // line traverses without retriggering Angular change detection (which
    // would re-evaluate every binding in the timeline and cause the zoom/
    // height range inputs to flicker).
    //
    // Position source priority:
    //   1. Spotify SDK reference clock when the sequence is Spotify-backed
    //      and a player snapshot is available — this is the same source
    //      the music console seek bar uses, so both stay in lock-step and
    //      we avoid reconciling two clocks (engine + Spotify).
    //   2. Otherwise, dead-reckon from the engine status anchor.
    effect(() => {
      const el = this.playheadEl()?.nativeElement;
      const label = this.playheadMsLabel()?.nativeElement;
      const isPlaying = this.isPlayingThis();
      const anchor = this.transport.playheadAnchor();
      const dur = this.durationMs();
      const useSpotify =
        this.transport.spotifyTrackUri() !== null &&
        this.spotify.playerSnapshot() !== null;
      this.cancelPlayheadRaf();
      if (!isPlaying || dur <= 0) return;
      const tick = () => {
        let pos: number;
        if (useSpotify) {
          pos = this.spotify.interpolatedPosition();
        } else if (anchor) {
          const elapsed = anchor.playing
            ? Math.max(0, performance.now() - anchor.clockMs)
            : 0;
          pos = anchor.posMs + elapsed;
        } else {
          pos = 0;
        }
        pos = Math.max(0, Math.min(pos, dur));
        if (el) el.style.left = `${(pos / dur) * 100}%`;
        if (label) label.textContent = String(Math.floor(pos));
        this.rafHandle = requestAnimationFrame(tick);
      };
      this.rafHandle = requestAnimationFrame(tick);
    });
  }

  private cancelPlayheadRaf(): void {
    if (this.rafHandle !== null) {
      cancelAnimationFrame(this.rafHandle);
      this.rafHandle = null;
    }
  }

  async ngOnInit(): Promise<void> {
    await this.sequences.list();
    if (this.library().length > 0) {
      await this.loadSequence(this.library()[0].id);
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
    this.deletePrompt.show({ id: seq.id, name: seq.name });
  }

  /** Open the confirm-delete modal for the loaded sequence. */
  protected requestDeleteSequence(): void {
    const seq = this.editing();
    if (!seq) return;
    this.deletePrompt.show({ id: seq.id, name: seq.name });
  }

  protected cancelDelete(): void {
    this.deletePrompt.hide();
  }

  /** Confirm-delete handler: perform the destructive call. */
  protected async confirmDelete(): Promise<void> {
    const target = this.deletePrompt.data();
    if (!target) return;
    this.deletePrompt.hide();
    try {
      await this.sequences.delete(target.id);
      const current = this.editing();
      if (current && current.id === target.id) {
        this.editing.set(null);
        this.selectedClipId.set(null);
      }
    } catch {
      // ignored
    }
  }

  protected toggleEditMode(): void {
    this.editMode.update((v) => !v);
  }

  // ---------- range controls ----------

  protected rangeStartPct(): number {
    const dur = this.durationMs();
    const v = this.rangeStartMs();
    if (dur <= 0 || v === null) return 0;
    return (v / dur) * 100;
  }

  protected rangeEndPct(): number {
    const dur = this.durationMs();
    const v = this.rangeEndMs();
    if (dur <= 0 || v === null) return 100;
    return (v / dur) * 100;
  }

  protected rangeWidthPct(): number {
    return Math.max(0, this.rangeEndPct() - this.rangeStartPct());
  }

  protected onRangeBarClick(event: MouseEvent): void {
    // Clicking on the bar (not a handle) creates a range or moves the closer
    // endpoint to the click position.
    if (this.dragState) return;
    if (!this.editMode()) return;
    const target = event.target as HTMLElement;
    if (target.dataset['rangeHandle']) return;
    const ms = this.clientXToMs(event.clientX);
    if (ms === null) return;
    const start = this.rangeStartMs();
    const end = this.rangeEndMs();
    if (start === null || end === null) {
      // Seed a small range centred on the click (10% of duration each side,
      // clamped to bounds).
      const dur = this.durationMs();
      const half = Math.max(200, Math.round(dur * 0.05));
      this.rangeStartMs.set(Math.max(0, ms - half));
      this.rangeEndMs.set(Math.min(dur, ms + half));
      return;
    }
    // Move the nearer endpoint.
    if (Math.abs(ms - start) <= Math.abs(ms - end)) {
      this.rangeStartMs.set(Math.max(0, Math.min(end - 50, ms)));
    } else {
      this.rangeEndMs.set(Math.max(start + 50, Math.min(this.durationMs(), ms)));
    }
  }

  // ---------- editing ----------

  protected onNameChange(value: string): void {
    const seq = this.editing();
    if (!seq || !this.editMode()) return;
    this.editing.set({ ...seq, name: value });
  }

  protected onDurationChange(value: number): void {
    const seq = this.editing();
    if (!seq || !this.editMode()) return;
    if (!Number.isFinite(value) || value <= 0) return;
    this.editing.set({ ...seq, duration_ms: Math.round(value) });
  }

  /** Click on empty timeline space → add a clip (only while edit mode is on). */
  protected onTrackClick(event: MouseEvent): void {
    if (this.dragState) return;
    if (!this.editMode()) return;
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
    if (!seq || !id || !this.editMode()) return;
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
    if (!seq || !id || !this.editMode()) return;
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

  // ---------- pattern (per-LED) editing ----------

  /** Number of pixels on the active strip. Falls back to 50 if unknown. */
  protected readonly pixelCount = computed(
    () => this.status()?.pixel_count ?? 50,
  );

  /** Selected clip's pattern expanded to one entry per pixel (for display). */
  protected readonly selectedPatternView = computed<ClipColor[] | null>(() => {
    const clip = this.selectedClip();
    if (!clip || !clip.pattern || clip.pattern.length === 0) return null;
    const n = this.pixelCount();
    const pat = clip.pattern;
    const out: ClipColor[] = new Array(n);
    for (let i = 0; i < n; i++) {
      out[i] = pat[i % pat.length];
    }
    return out;
  });

  protected hasPattern(): boolean {
    const c = this.selectedClip();
    return !!c?.pattern && c.pattern.length > 0;
  }

  /** Seed the selected clip's pattern from its current solid color. */
  protected enablePattern(): void {
    const clip = this.selectedClip();
    if (!clip) return;
    const n = this.pixelCount();
    const seed: ClipColor[] = new Array(n).fill({ ...clip.color });
    this.onClipFieldChange('pattern', seed);
  }

  /** Drop the per-pixel pattern; clip reverts to effect-based rendering. */
  protected clearPattern(): void {
    this.onClipFieldChange('pattern', undefined as unknown as ClipColor[]);
  }

  /** Paint a single pixel: writes the clip's color, or black if erase mode is on. */
  protected paintPixel(index: number): void {
    const clip = this.selectedClip();
    if (!clip || !clip.pattern) return;
    const n = this.pixelCount();
    // Ensure pattern length matches the strip (so per-index edits are stable).
    let next: ClipColor[];
    if (clip.pattern.length === n) {
      next = clip.pattern.slice();
    } else {
      next = new Array(n);
      for (let i = 0; i < n; i++) {
        next[i] = clip.pattern[i % clip.pattern.length];
      }
    }
    if (index < 0 || index >= n) return;
    next[index] = this.eraseMode()
      ? { r: 0, g: 0, b: 0 }
      : { ...clip.color };
    this.onClipFieldChange('pattern', next);
  }

  /** Right-click handler: always sets the pixel off regardless of erase mode. */
  protected disablePixel(event: MouseEvent, index: number): void {
    event.preventDefault();
    const clip = this.selectedClip();
    if (!clip || !clip.pattern) return;
    const n = this.pixelCount();
    let next: ClipColor[];
    if (clip.pattern.length === n) {
      next = clip.pattern.slice();
    } else {
      next = new Array(n);
      for (let i = 0; i < n; i++) {
        next[i] = clip.pattern[i % clip.pattern.length];
      }
    }
    if (index < 0 || index >= n) return;
    next[index] = { r: 0, g: 0, b: 0 };
    this.onClipFieldChange('pattern', next);
  }

  /** Fill every pixel in the pattern with the clip's current color. */
  protected fillPattern(): void {
    const clip = this.selectedClip();
    if (!clip || !clip.pattern) return;
    const n = this.pixelCount();
    const filled: ClipColor[] = new Array(n).fill({ ...clip.color });
    this.onClipFieldChange('pattern', filled);
  }

  /** Turn every LED off for the selected clip (writes black to every pixel). */
  protected disableAllPixels(): void {
    const clip = this.selectedClip();
    if (!clip || !clip.pattern) return;
    const n = this.pixelCount();
    const off: ClipColor[] = new Array(n).fill({ r: 0, g: 0, b: 0 });
    this.onClipFieldChange('pattern', off);
  }

  protected toggleEraseMode(): void {
    this.eraseMode.update((v) => !v);
  }

  protected isPixelOff(c: ClipColor): boolean {
    return c.r === 0 && c.g === 0 && c.b === 0;
  }

  protected pixelColorCss(c: ClipColor): string {
    return `rgb(${c.r}, ${c.g}, ${c.b})`;
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
    // Selection alone is allowed for inspection while not editing; only
    // start a drag when edit mode is on so the user can’t accidentally
    // shuffle clips around.
    this.selectedClipId.set(clipId);
    if (!this.editMode()) return;
    event.preventDefault();
    event.stopPropagation();
    (event.target as Element).setPointerCapture?.(event.pointerId);
    this.dragState = {
      clipId,
      kind,
      pointerId: event.pointerId,
      startClientX: event.clientX,
      origStartMs: clip.start_ms,
      origDurationMs: clip.duration_ms,
    };
  }

  /** Pointer-down on a range marker / band. */
  protected onRangePointerDown(
    event: PointerEvent,
    kind: 'range-start' | 'range-end' | 'range-band',
  ): void {
    if (!this.editMode()) return;
    event.preventDefault();
    event.stopPropagation();
    (event.target as Element).setPointerCapture?.(event.pointerId);
    this.dragState = {
      clipId: '',
      kind,
      pointerId: event.pointerId,
      startClientX: event.clientX,
      origStartMs: 0,
      origDurationMs: 0,
      origRangeStartMs: this.rangeStartMs() ?? 0,
      origRangeEndMs: this.rangeEndMs() ?? 0,
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

    // Range-marker drags don't touch clips.
    if (
      drag.kind === 'range-start' ||
      drag.kind === 'range-end' ||
      drag.kind === 'range-band'
    ) {
      const origStart = drag.origRangeStartMs ?? 0;
      const origEnd = drag.origRangeEndMs ?? seq.duration_ms;
      if (drag.kind === 'range-start') {
        const next = Math.round(
          Math.max(0, Math.min(origEnd - 50, origStart + dxMs)),
        );
        this.rangeStartMs.set(next);
      } else if (drag.kind === 'range-end') {
        const next = Math.round(
          Math.max(origStart + 50, Math.min(seq.duration_ms, origEnd + dxMs)),
        );
        this.rangeEndMs.set(next);
      } else {
        const width = origEnd - origStart;
        const minStart = 0;
        const maxStart = Math.max(0, seq.duration_ms - width);
        const nextStart = Math.round(
          Math.max(minStart, Math.min(maxStart, origStart + dxMs)),
        );
        this.rangeStartMs.set(nextStart);
        this.rangeEndMs.set(nextStart + width);
      }
      return;
    }

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
