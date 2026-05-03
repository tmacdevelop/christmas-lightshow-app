import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  HostListener,
  OnDestroy,
  OnInit,
  computed,
  effect,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { FormsModule } from '@angular/forms';

import {
  Layout,
  LayoutService,
  Point,
  Prop,
  StripGeometry,
} from './layout.service';
import { ShowControlService } from './show-control.service';

const DEFAULT_WIDTH = 800;
const DEFAULT_HEIGHT = 500;
const DEFAULT_PIXEL_COUNT = 30;
const HANDLE_RADIUS = 6;
const POLL_INTERVAL_MS = 1000;

type DragKind = 'start' | 'end' | 'move';

interface DragState {
  propId: string;
  kind: DragKind;
  pointerId: number;
  // Pointer-down position in svg coords + the original endpoints, so each
  // pointermove can recompute against the captured state without drift.
  origStart: Point;
  origEnd: Point;
  pointerOrigin: Point;
}

let nextLocalId = 1;
function makeId(prefix: string): string {
  const rand = Math.random().toString(36).slice(2, 8);
  return `${prefix}-${Date.now().toString(36)}-${(nextLocalId++).toString(
    36,
  )}-${rand}`;
}

function ensureStrip(prop: Prop): StripGeometry {
  if (prop.geometry.type !== 'strip') {
    throw new Error(`unsupported geometry: ${prop.geometry.type}`);
  }
  return prop.geometry;
}

@Component({
  selector: 'app-layout-designer',
  standalone: true,
  imports: [FormsModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './layout-designer.html',
  styleUrl: './layout-designer.css',
})
export class LayoutDesignerComponent implements OnInit, OnDestroy {
  protected readonly layouts = inject(LayoutService);
  protected readonly control = inject(ShowControlService);

  protected readonly svgRef = viewChild.required<ElementRef<SVGSVGElement>>('svg');

  /** The layout currently being edited (a working copy). */
  protected readonly editing = signal<Layout | null>(null);
  protected readonly selectedPropId = signal<string | null>(null);

  protected readonly props = computed(() => this.editing()?.props ?? []);
  protected readonly width = computed(
    () => this.editing()?.width ?? DEFAULT_WIDTH,
  );
  protected readonly height = computed(
    () => this.editing()?.height ?? DEFAULT_HEIGHT,
  );
  protected readonly viewBox = computed(
    () => `0 0 ${this.width()} ${this.height()}`,
  );

  protected readonly selectedProp = computed(() => {
    const id = this.selectedPropId();
    return id ? this.props().find((p) => p.id === id) ?? null : null;
  });

  /** Active layout id reported by the server. */
  protected readonly activeLayoutId = computed(
    () => this.control.status()?.active_layout_id ?? null,
  );

  protected readonly isEditingActive = computed(() => {
    const ed = this.editing();
    return ed != null && this.activeLayoutId() === ed.id;
  });

  private drag: DragState | null = null;
  private pollHandle: ReturnType<typeof setInterval> | null = null;

  constructor() {
    // Refresh the library whenever the active layout changes (e.g. another
    // tab activated something), so the dropdown stays in sync.
    effect(() => {
      this.activeLayoutId();
    });
  }

  async ngOnInit(): Promise<void> {
    await this.layouts.list();
    await this.control.loadStatus();
    this.pollHandle = setInterval(
      () => this.control.loadStatus(),
      POLL_INTERVAL_MS,
    );
  }

  ngOnDestroy(): void {
    if (this.pollHandle) {
      clearInterval(this.pollHandle);
    }
  }

  // ---------- library actions ----------

  protected newLayout(): void {
    this.editing.set({
      id: makeId('layout'),
      name: 'Untitled layout',
      width: DEFAULT_WIDTH,
      height: DEFAULT_HEIGHT,
      props: [],
    });
    this.selectedPropId.set(null);
  }

  protected async loadFromLibrary(id: string): Promise<void> {
    if (!id) {
      this.editing.set(null);
      this.selectedPropId.set(null);
      return;
    }
    const layout = await this.layouts.get(id);
    // Deep clone so edits don't mutate the cached library entry.
    this.editing.set(JSON.parse(JSON.stringify(layout)) as Layout);
    this.selectedPropId.set(null);
  }

  protected async save(): Promise<void> {
    const layout = this.editing();
    if (!layout) return;
    await this.layouts.save(layout);
  }

  protected async deleteCurrent(): Promise<void> {
    const layout = this.editing();
    if (!layout) return;
    if (!confirm(`Delete layout "${layout.name}"?`)) return;
    await this.layouts.delete(layout.id);
    this.editing.set(null);
    this.selectedPropId.set(null);
  }

  protected async toggleActive(): Promise<void> {
    const layout = this.editing();
    if (!layout) return;
    if (this.isEditingActive()) {
      await this.layouts.deactivate();
    } else {
      // Saving first guarantees the server has the version we're activating.
      await this.layouts.save(layout);
      await this.layouts.activate(layout.id);
    }
    await this.control.loadStatus();
  }

  // ---------- editing helpers ----------

  protected updateName(name: string): void {
    this.editing.update((l) => (l ? { ...l, name } : l));
  }

  protected updateDimensions(width: number, height: number): void {
    this.editing.update((l) =>
      l
        ? {
            ...l,
            width: Math.max(50, width),
            height: Math.max(50, height),
          }
        : l,
    );
  }

  protected addStripAt(p: Point): void {
    const layout = this.editing();
    if (!layout) return;
    // Default to a 100-unit horizontal strip seeded next to the pointer.
    const start: Point = { x: Math.max(0, p.x - 50), y: p.y };
    const end: Point = { x: Math.min(layout.width, p.x + 50), y: p.y };
    const offset = nextOffset(layout);
    const id = makeId('prop');
    const prop: Prop = {
      id,
      name: `Strip ${layout.props.length + 1}`,
      pixel_offset: offset,
      pixel_count: DEFAULT_PIXEL_COUNT,
      geometry: { type: 'strip', start, end },
    };
    this.editing.set({ ...layout, props: [...layout.props, prop] });
    this.selectedPropId.set(id);
  }

  protected updateSelectedProp(patch: Partial<Prop>): void {
    const id = this.selectedPropId();
    if (!id) return;
    this.editing.update((l) =>
      l
        ? {
            ...l,
            props: l.props.map((p) => (p.id === id ? { ...p, ...patch } : p)),
          }
        : l,
    );
  }

  protected removeSelected(): void {
    const id = this.selectedPropId();
    if (!id) return;
    this.editing.update((l) =>
      l ? { ...l, props: l.props.filter((p) => p.id !== id) } : l,
    );
    this.selectedPropId.set(null);
  }

  // ---------- canvas interaction ----------

  protected onCanvasPointerDown(event: PointerEvent): void {
    // Only react to clicks on empty canvas — i.e. anything that isn't part of
    // an existing prop. The grid <rect> and the <svg> itself both count as
    // "empty"; props live inside <g class="prop"> and stop propagation.
    const target = event.target as Element | null;
    if (target?.closest('.prop')) {
      return;
    }
    const p = this.toSvg(event);
    if (!p) return;
    this.addStripAt(p);
  }

  protected onPropPointerDown(
    event: PointerEvent,
    prop: Prop,
    kind: DragKind,
  ): void {
    event.stopPropagation();
    const p = this.toSvg(event);
    if (!p) return;
    const strip = ensureStrip(prop);
    this.selectedPropId.set(prop.id);
    this.drag = {
      propId: prop.id,
      kind,
      pointerId: event.pointerId,
      origStart: { ...strip.start },
      origEnd: { ...strip.end },
      pointerOrigin: p,
    };
    (event.target as Element).setPointerCapture?.(event.pointerId);
  }

  @HostListener('window:pointermove', ['$event'])
  protected onPointerMove(event: PointerEvent): void {
    if (!this.drag || event.pointerId !== this.drag.pointerId) return;
    const p = this.toSvg(event);
    if (!p) return;
    const dx = p.x - this.drag.pointerOrigin.x;
    const dy = p.y - this.drag.pointerOrigin.y;
    const layout = this.editing();
    if (!layout) return;
    const clamp = (pt: Point): Point => ({
      x: Math.max(0, Math.min(layout.width, pt.x)),
      y: Math.max(0, Math.min(layout.height, pt.y)),
    });

    const props = layout.props.map((prop) => {
      if (prop.id !== this.drag!.propId) return prop;
      const strip = ensureStrip(prop);
      let start = strip.start;
      let end = strip.end;
      switch (this.drag!.kind) {
        case 'start':
          start = clamp({
            x: this.drag!.origStart.x + dx,
            y: this.drag!.origStart.y + dy,
          });
          break;
        case 'end':
          end = clamp({
            x: this.drag!.origEnd.x + dx,
            y: this.drag!.origEnd.y + dy,
          });
          break;
        case 'move':
          start = clamp({
            x: this.drag!.origStart.x + dx,
            y: this.drag!.origStart.y + dy,
          });
          end = clamp({
            x: this.drag!.origEnd.x + dx,
            y: this.drag!.origEnd.y + dy,
          });
          break;
      }
      return { ...prop, geometry: { type: 'strip', start, end } as StripGeometry };
    });
    this.editing.set({ ...layout, props });
  }

  @HostListener('window:pointerup', ['$event'])
  protected onPointerUp(event: PointerEvent): void {
    if (this.drag && event.pointerId === this.drag.pointerId) {
      this.drag = null;
    }
  }

  /**
   * Delete-key shortcut: if a prop is selected and focus isn't trapped by an
   * `<input>` / `<textarea>` (so users can still backspace inside the name
   * field), drop the selected prop.
   */
  @HostListener('window:keydown', ['$event'])
  protected onKeyDown(event: KeyboardEvent): void {
    if (event.key !== 'Delete' && event.key !== 'Backspace') return;
    if (!this.selectedPropId()) return;
    const tag = (event.target as Element | null)?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    event.preventDefault();
    this.removeSelected();
  }

  // ---------- view helpers (used in template) ----------

  protected stripStart(prop: Prop): Point {
    return ensureStrip(prop).start;
  }
  protected stripEnd(prop: Prop): Point {
    return ensureStrip(prop).end;
  }

  protected handleRadius(): number {
    return HANDLE_RADIUS;
  }

  protected selectProp(id: string): void {
    this.selectedPropId.set(id);
  }

  /** Convert a pointer event to coordinates inside the SVG viewBox. */
  private toSvg(event: PointerEvent): Point | null {
    const svg = this.svgRef().nativeElement;
    const rect = svg.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return null;
    const x = ((event.clientX - rect.left) / rect.width) * this.width();
    const y = ((event.clientY - rect.top) / rect.height) * this.height();
    return { x, y };
  }
}

/** Compute the next free pixel offset for a new prop. */
function nextOffset(layout: Layout): number {
  let max = 0;
  for (const p of layout.props) {
    const end = p.pixel_offset + p.pixel_count;
    if (end > max) max = end;
  }
  return max;
}
