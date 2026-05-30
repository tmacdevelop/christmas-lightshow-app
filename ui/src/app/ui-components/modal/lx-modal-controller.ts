import { signal, type Signal } from '@angular/core';

/**
 * Small state container for driving an {@link LxModal} imperatively from a
 * parent component. Bind `controller.open` to `<lx-modal [open]="...">`
 * and call `controller.show()` / `controller.hide()` / `controller.toggle()`
 * from event handlers.
 *
 * Usage:
 *   protected readonly deletePrompt = new LxModalController<{ id: string }>();
 *
 *   onDeleteClick(id: string) {
 *     this.deletePrompt.show({ id });
 *   }
 *
 *   <lx-modal
 *     [open]="deletePrompt.open()"
 *     (close)="deletePrompt.hide()"
 *   >
 *     ...{{ deletePrompt.data()?.id }}...
 *   </lx-modal>
 *
 * The controller intentionally does not own the close-animation timer —
 * `<lx-modal>` does that internally. Calling `hide()` flips `open` to false,
 * the modal plays its exit animation, then unmounts.
 */
export class LxModalController<TData = void> {
  private readonly _open = signal(false);
  private readonly _data = signal<TData | null>(null);

  /** Bind to `<lx-modal [open]="...">`. */
  readonly open: Signal<boolean> = this._open.asReadonly();
  /** Optional payload supplied via `show(data)`. */
  readonly data: Signal<TData | null> = this._data.asReadonly();

  /** Open the modal, optionally attaching a data payload. */
  show(data?: TData): void {
    if (data !== undefined) this._data.set(data);
    this._open.set(true);
  }

  /** Close the modal. The modal plays its exit animation before unmounting. */
  hide(): void {
    this._open.set(false);
  }

  /** Toggle visibility. */
  toggle(): void {
    this._open.update((v) => !v);
  }

  /**
   * True only while the modal is open. Useful inside `@if` guards in the
   * parent template when you need to access `data()` without null checks.
   */
  isOpen(): boolean {
    return this._open();
  }
}
