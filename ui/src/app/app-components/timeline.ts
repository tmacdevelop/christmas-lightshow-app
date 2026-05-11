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
import { DecimalPipe } from '@angular/common';

import { SequenceService } from '../services/sequence.service';
import { Clip, ClipColor, Sequence } from '../models/sequence.models';
import { ShowControlService } from '../services/show-control.service';
import { EffectKind } from '../models/show.models';
import { SpotifyService } from '../services/spotify.service';

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
  imports: [FormsModule, DecimalPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './timeline.html',
  styleUrl: './timeline.css',
})
export class TimelineComponent implements OnInit {
  private readonly sequences = inject(SequenceService);
  private readonly control = inject(ShowControlService);
  private readonly spotify = inject(SpotifyService);

  protected readonly track =
    viewChild.required<ElementRef<HTMLDivElement>>('track');

  protected readonly library = this.sequences.sequences;
  protected readonly lastError = this.sequences.lastError;
  protected readonly status = this.control.status;

  protected readonly editing = signal<Sequence | null>(null);
  protected readonly selectedClipId = signal<string | null>(null);
  protected readonly looping = signal<boolean>(true);

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

  /** Playback range — when non-null, Play loops between these markers. */
  protected readonly rangeStartMs = signal<number | null>(null);
  protected readonly rangeEndMs = signal<number | null>(null);
  protected readonly rangeActive = computed(
    () => this.rangeStartMs() !== null && this.rangeEndMs() !== null,
  );
  /** Guard: avoid issuing parallel sync requests while one is in flight. */
  private rangeResyncing = false;

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
  protected readonly playheadMs = computed(() => {
    const pb = this.status()?.playback;
    if (!pb || pb.mode !== 'sequence') return null;
    if (pb.sequence_id !== this.editingId()) return null;
    return pb.position_ms;
  });
  protected readonly isPlayingThis = computed(() => this.playheadMs() !== null);

  /**
   * If the currently-loaded sequence was generated from a Spotify track, its
   * id is `spotify-{trackId}`. Surface the URI so the timeline can drive
   * Spotify playback in sync with editing.
   */
  protected readonly spotifyTrackUri = computed<string | null>(() => {
    const id = this.editingId();
    if (!id) return null;
    const match = /^spotify-([A-Za-z0-9]+)$/.exec(id);
    return match ? `spotify:track:${match[1]}` : null;
  });
  protected readonly spotifySnapshot = this.spotify.playerSnapshot;
  protected readonly spotifyMuted = this.spotify.muted;
  protected readonly spotifyVolume = this.spotify.volume;
  protected readonly spotifyAuthed = computed(
    () => this.spotify.status().authenticated,
  );

  private dragState: DragState | null = null;

  constructor() {
    // Range-loop watcher: when a play range is active and the engine's
    // playhead crosses the end marker, rewind it to the start. Runs whenever
    // the status signal updates (ticker pushes ~10/sec while playing).
    effect(() => {
      const pos = this.playheadMs();
      const start = this.rangeStartMs();
      const end = this.rangeEndMs();
      if (pos === null || start === null || end === null) return;
      if (end <= start) return;
      if (pos < end) return;
      if (this.rangeResyncing) return;
      this.rangeResyncing = true;
      // Seek both Spotify (so the song wraps too) and the engine. When
      // Spotify is the master, its 10Hz sync push would otherwise drag the
      // engine playhead right back past the end marker; seeking the player
      // first ensures the next push lands inside the range.
      const snap = this.spotify.playerSnapshot();
      const spotifyActive = snap !== null && !snap.paused;
      const tasks: Promise<unknown>[] = [
        this.sequences.seek(start).catch(() => undefined),
      ];
      if (spotifyActive) {
        tasks.push(this.spotify.seek(start).catch(() => undefined));
      }
      Promise.all(tasks).finally(() => {
        this.rangeResyncing = false;
      });
    });
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
      // If a loop range is set, force `loop=true` regardless of the Loop
      // checkbox so the range watcher can keep rewinding the playhead.
      const looping = this.rangeActive() ? true : this.looping();
      await this.sequences.play(seq.id, looping);
      // Snap the engine to the range start so playback begins inside the
      // selected window. Without this, playback always starts at 0.
      const start = this.rangeStartMs();
      if (start !== null) {
        await this.sequences.seek(start);
      }
      // Drive Spotify alongside the sequencer when this sequence was built
      // from a Spotify track. Music + lights need to start together so the
      // editor can author per-LED patterns against the actual song.
      const uri = this.spotifyTrackUri();
      if (uri && this.spotifyAuthed()) {
        try {
          const offset = start ?? 0;
          // If the same track is already loaded in the player, just seek
          // and resume — calling play with `position_ms` re-issues a fresh
          // playback request which can momentarily report position 0 and
          // tug the engine playhead with it.
          const snap = this.spotify.playerSnapshot();
          const trackId = uri.replace('spotify:track:', '');
          if (snap && snap.track_id === trackId) {
            await this.spotify.seek(offset);
            await this.spotify.resume();
          } else {
            // Fresh start: pass position_ms in the play body so the very
            // first state event reports the desired offset (avoids the
            // 10Hz sync loop snapping the engine back to 0).
            await this.spotify.ensurePlaying(uri, offset);
          }
        } catch {
          // SpotifyService surfaces details in lastError; the sequencer
          // continues even if Spotify can't start.
        }
      }
      await this.control.loadStatus();
    } catch {
      // ignored
    }
  }

  protected async stop(): Promise<void> {
    try {
      // First leave sequence mode, then pause the live show so the engine
      // doesn't immediately resume the default live effect. Without the
      // second call, "stop" felt like "pause the song" because the live
      // effect kept rendering underneath.
      await this.sequences.stop();
      await this.control.stop();
      // Pause the Spotify track too so a single Stop button stops
      // everything the user can hear and see.
      if (this.spotifyTrackUri() && this.spotifyAuthed()) {
        await this.spotify.pause().catch(() => undefined);
      }
      await this.control.loadStatus();
    } catch {
      // ignored
    }
  }

  protected toggleEditMode(): void {
    this.editMode.update((v) => !v);
  }

  // ---------- Spotify music transport ----------

  /**
   * Begin playback of the Spotify track associated with the loaded
   * sequence. Used while editing to hear the music so per-LED patterns
   * can be authored against the actual song.
   */
  protected async playMusic(): Promise<void> {
    const uri = this.spotifyTrackUri();
    if (!uri) return;
    try {
      await this.spotify.ensurePlaying(uri);
      // If a play range is active, jump Spotify to the start so the song
      // and the lights stay aligned with what's being edited.
      const start = this.rangeStartMs();
      if (start !== null) {
        await this.spotify.seek(start);
      }
    } catch {
      // SpotifyService surfaces details in lastError.
    }
  }

  protected async pauseMusic(): Promise<void> {
    await this.spotify.pause().catch(() => undefined);
  }

  protected async restartMusic(): Promise<void> {
    await this.spotify.restart().catch(() => undefined);
  }

  protected async toggleMusicMute(): Promise<void> {
    await this.spotify.toggleMute().catch(() => undefined);
  }

  protected onMusicVolumeInput(value: number): void {
    this.spotify.setVolume(value).catch(() => undefined);
  }

  // ---------- range controls ----------

  protected clearRange(): void {
    this.rangeStartMs.set(null);
    this.rangeEndMs.set(null);
  }

  /** Initialize a range to roughly the visible centre third of the sequence. */
  protected setRange(): void {
    const dur = this.durationMs();
    if (dur <= 0) return;
    this.rangeStartMs.set(Math.round(dur * 0.33));
    this.rangeEndMs.set(Math.round(dur * 0.66));
  }

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

  /** Pointer-down on a range marker / band. */
  protected onRangePointerDown(
    event: PointerEvent,
    kind: 'range-start' | 'range-end' | 'range-band',
  ): void {
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
