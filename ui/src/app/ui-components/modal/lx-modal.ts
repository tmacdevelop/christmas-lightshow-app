import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  HostListener,
  input,
  output,
  signal,
} from '@angular/core';

export type LxModalSize = 'sm' | 'md' | 'lg' | 'xl';

const SIZE_CLASSES: Record<LxModalSize, string> = {
  sm: 'max-w-sm',
  md: 'max-w-md',
  lg: 'max-w-lg',
  xl: 'max-w-2xl',
};

let modalIdCounter = 0;

/**
 * Reusable animated modal dialog.
 *
 * The modal is mounted whenever `open` is true. When the parent flips `open`
 * back to false, the component plays its exit animation, then unmounts —
 * so consumers can simply bind `[open]="someSignal()"` without worrying
 * about animation timing.
 *
 * Slots:
 *   default            — modal body
 *   [modal-footer]     — actions area (already styled with separator)
 *
 * Inputs:
 *   title              — string shown in the header (header hidden if empty
 *                        and no [modal-header] content)
 *   size               — width preset (sm | md | lg | xl). Default 'md'.
 *   dismissable        — when false, ESC and backdrop click do nothing.
 *                        The (close) output also won't be emitted.
 *   showClose          — show the small (×) header close button. Default true
 *                        when dismissable is true.
 *   closeOnBackdrop    — default true.
 *   closeOnEscape      — default true.
 *
 * Outputs:
 *   close              — fired when user dismisses (ESC, backdrop, or × btn)
 *
 * The actual destructive action (e.g. deleting something) should be wired in
 * the projected footer buttons so consumers retain control over confirm flow.
 */
@Component({
  selector: 'lx-modal',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (rendered()) {
      <div
        class="lx-modal-backdrop fixed inset-0 z-50 flex items-center justify-center p-4"
        [class.is-closing]="closing()"
        role="dialog"
        aria-modal="true"
        [attr.aria-labelledby]="title() ? titleId : null"
        (click)="onBackdropClick()"
      >
        <div
          class="lx-modal-card w-full"
          [class]="cardSizeClass()"
          (click)="$event.stopPropagation()"
        >
          @if (title() || showClose()) {
            <header
              class="flex items-center justify-between gap-3 border-b border-zinc-800 px-4 py-3"
            >
              @if (title()) {
                <h3
                  [id]="titleId"
                  class="text-base font-semibold text-zinc-100"
                >
                  {{ title() }}
                </h3>
              } @else {
                <span></span>
              }
              @if (showClose()) {
                <button
                  type="button"
                  class="lx-modal-close rounded p-1 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-400/40"
                  aria-label="Close"
                  (click)="requestClose()"
                >
                  <svg
                    width="16"
                    height="16"
                    viewBox="0 0 16 16"
                    fill="none"
                    aria-hidden="true"
                  >
                    <path
                      d="M3 3l10 10M13 3L3 13"
                      stroke="currentColor"
                      stroke-width="1.6"
                      stroke-linecap="round"
                    />
                  </svg>
                </button>
              }
            </header>
          }

          <div class="px-4 py-4 text-sm text-zinc-300">
            <ng-content />
          </div>

          <footer
            class="flex justify-end gap-2 border-t border-zinc-800 bg-zinc-950/40 px-4 py-3"
          >
            <ng-content select="[modal-footer]" />
          </footer>
        </div>
      </div>
    }
  `,
  styleUrl: './lx-modal.css',
})
export class LxModal {
  readonly open = input<boolean>(false);
  readonly title = input<string>('');
  readonly size = input<LxModalSize>('md');
  readonly dismissable = input<boolean>(true);
  readonly showClose = input<boolean>(true);
  readonly closeOnBackdrop = input<boolean>(true);
  readonly closeOnEscape = input<boolean>(true);

  readonly close = output<void>();

  /** Used by aria-labelledby. Unique enough across an app session. */
  protected readonly titleId = `lx-modal-title-${++modalIdCounter}`;

  /** Whether the DOM is currently rendered (covers exit animation). */
  protected readonly rendered = signal(false);
  /** True while the exit animation is playing. */
  protected readonly closing = signal(false);

  protected readonly cardSizeClass = computed(() => SIZE_CLASSES[this.size()]);

  /** Match the longest exit keyframe in lx-modal.css. */
  private static readonly CLOSE_MS = 360;
  private closeTimer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    effect(() => {
      const open = this.open();
      if (open) this.handleOpen();
      else this.handleClose();
    });
  }

  /**
   * Imperatively show the modal. Mirrors flipping `[open]` to true. Useful
   * when the parent grabs the component via `viewChild(LxModal)`.
   */
  show(): void {
    this.handleOpen();
  }

  /** Imperatively hide the modal — plays the exit animation then unmounts. */
  hide(): void {
    this.handleClose();
  }

  /** Toggle visibility. */
  toggle(): void {
    if (this.rendered() && !this.closing()) this.hide();
    else this.show();
  }

  private handleOpen(): void {
    if (this.closeTimer !== null) {
      clearTimeout(this.closeTimer);
      this.closeTimer = null;
    }
    this.closing.set(false);
    this.rendered.set(true);
  }

  private handleClose(): void {
    if (!this.rendered()) return;
    this.closing.set(true);
    this.closeTimer = setTimeout(() => {
      this.rendered.set(false);
      this.closing.set(false);
      this.closeTimer = null;
    }, LxModal.CLOSE_MS);
  }

  protected onBackdropClick(): void {
    if (!this.dismissable() || !this.closeOnBackdrop()) return;
    this.requestClose();
  }

  @HostListener('document:keydown.escape')
  protected onEscape(): void {
    if (!this.rendered() || this.closing()) return;
    if (!this.dismissable() || !this.closeOnEscape()) return;
    this.requestClose();
  }

  protected requestClose(): void {
    if (!this.dismissable()) return;
    this.close.emit();
  }
}
