import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
  output,
} from '@angular/core';
import { LxModal, type LxModalSize } from './lx-modal';

export type LxConfirmVariant = 'danger' | 'primary' | 'warning';

const VARIANT_BTN: Record<LxConfirmVariant, string> = {
  danger: 'bg-red-700 hover:bg-red-600',
  primary: 'bg-blue-600 hover:bg-blue-500',
  warning: 'bg-amber-600 hover:bg-amber-500',
};

/**
 * Confirmation dialog. Wraps {@link LxModal} with a body slot, a Cancel
 * button, and a Confirm button whose color reflects the action variant.
 *
 * Both buttons fire on pointer-up (default browser click) so the new tactile
 * `.btn-press` styles read naturally — visual press on mousedown, action on
 * release.
 *
 * Inputs:
 *   open           — controls visibility
 *   title          — header text
 *   message        — body text. For richer markup, project content into the
 *                    default slot instead (it will replace the message).
 *   confirmLabel   — defaults to 'Confirm'
 *   cancelLabel    — defaults to 'Cancel'
 *   variant        — colors the confirm button. Default 'danger'.
 *   size           — passed through to LxModal. Default 'md'.
 *   busy           — when true, disables both buttons (e.g. during async work)
 *
 * Outputs:
 *   confirm        — user clicked confirm
 *   cancel         — user clicked cancel / dismissed
 */
@Component({
  selector: 'lx-confirm-modal',
  standalone: true,
  imports: [LxModal],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <lx-modal
      [open]="open()"
      [title]="title()"
      [size]="size()"
      [showClose]="false"
      (close)="cancel.emit()"
    >
      @if (message()) {
        <p>{{ message() }}</p>
      }
      <ng-content />

      <div modal-footer class="contents">
        <button
          type="button"
          class="btn-press rounded bg-zinc-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-zinc-600 disabled:cursor-not-allowed disabled:opacity-50"
          [disabled]="busy()"
          (click)="cancel.emit()"
        >
          {{ cancelLabel() }}
        </button>
        <button
          type="button"
          class="btn-press rounded px-3 py-1.5 text-sm font-medium text-white disabled:cursor-not-allowed disabled:opacity-50"
          [class]="confirmBtnClass()"
          [disabled]="busy()"
          (click)="confirm.emit()"
          autofocus
        >
          {{ confirmLabel() }}
        </button>
      </div>
    </lx-modal>
  `,
})
export class LxConfirmModal {
  readonly open = input<boolean>(false);
  readonly title = input<string>('Confirm');
  readonly message = input<string>('');
  readonly confirmLabel = input<string>('Confirm');
  readonly cancelLabel = input<string>('Cancel');
  readonly variant = input<LxConfirmVariant>('danger');
  readonly size = input<LxModalSize>('md');
  readonly busy = input<boolean>(false);

  readonly confirm = output<void>();
  readonly cancel = output<void>();

  protected readonly confirmBtnClass = computed(
    () => VARIANT_BTN[this.variant()],
  );
}
