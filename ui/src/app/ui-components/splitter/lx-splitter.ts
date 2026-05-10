import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  HostListener,
  computed,
  inject,
  input,
  model,
  signal,
} from '@angular/core';

export type LxSplitterOrientation = 'horizontal' | 'vertical';

/**
 * Two-pane resizable splitter using a draggable gutter. Project two children
 * via the `lx-splitter-pane` slots. The `size` model is the size of the
 * **first** pane in pixels.
 *
 * - orientation="horizontal" → panes side-by-side, gutter is a vertical bar.
 * - orientation="vertical"   → panes stacked, gutter is a horizontal bar.
 */
@Component({
  selector: 'lx-splitter',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    class: 'flex h-full min-h-0 w-full min-w-0',
    '[class.flex-row]': "orientation() === 'horizontal'",
    '[class.flex-col]': "orientation() === 'vertical'",
  },
  template: `
    <div
      class="min-h-0 min-w-0 overflow-hidden"
      [style.flex]="firstFlex()"
    >
      <ng-content select="[lx-splitter-pane=first]" />
    </div>
    <div
      role="separator"
      tabindex="0"
      [attr.aria-orientation]="
        orientation() === 'horizontal' ? 'vertical' : 'horizontal'
      "
      class="group relative shrink-0 bg-zinc-800 transition-colors hover:bg-emerald-500/40 focus-visible:outline-none focus-visible:bg-emerald-500/40"
      [class.w-1]="orientation() === 'horizontal'"
      [class.h-1]="orientation() === 'vertical'"
      [class.cursor-col-resize]="orientation() === 'horizontal'"
      [class.cursor-row-resize]="orientation() === 'vertical'"
      (pointerdown)="onPointerDown($event)"
    ></div>
    <div class="min-h-0 min-w-0 flex-1 overflow-hidden">
      <ng-content select="[lx-splitter-pane=second]" />
    </div>
  `,
})
export class LxSplitter {
  private readonly host = inject(ElementRef<HTMLElement>);

  readonly orientation = input<LxSplitterOrientation>('horizontal');
  /** Size of the first pane in pixels. */
  readonly size = model<number>(280);
  readonly min = input<number>(120);
  readonly max = input<number>(1200);

  protected readonly firstFlex = computed(() => `0 0 ${this.size()}px`);

  private dragging = signal(false);
  private pointerId: number | null = null;
  private origSize = 0;
  private origPointer = 0;

  protected onPointerDown(event: PointerEvent): void {
    event.preventDefault();
    (event.target as Element).setPointerCapture?.(event.pointerId);
    this.pointerId = event.pointerId;
    this.dragging.set(true);
    this.origSize = this.size();
    this.origPointer =
      this.orientation() === 'horizontal' ? event.clientX : event.clientY;
  }

  @HostListener('window:pointermove', ['$event'])
  onPointerMove(event: PointerEvent): void {
    if (!this.dragging() || event.pointerId !== this.pointerId) return;
    const horizontal = this.orientation() === 'horizontal';
    const delta = (horizontal ? event.clientX : event.clientY) - this.origPointer;
    const next = Math.max(
      this.min(),
      Math.min(this.max(), this.origSize + delta),
    );
    this.size.set(next);
  }

  @HostListener('window:pointerup', ['$event'])
  onPointerUp(event: PointerEvent): void {
    if (event.pointerId !== this.pointerId) return;
    this.dragging.set(false);
    this.pointerId = null;
  }
}
