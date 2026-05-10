import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
} from '@angular/core';

export type LxButtonVariant =
  | 'primary'
  | 'secondary'
  | 'danger'
  | 'ghost'
  | 'success';

export type LxButtonSize = 'sm' | 'md';

const VARIANT_CLASSES: Record<LxButtonVariant, string> = {
  primary:
    'bg-blue-600 text-white hover:bg-blue-500 focus-visible:ring-blue-400/40',
  secondary:
    'bg-zinc-700 text-zinc-100 hover:bg-zinc-600 focus-visible:ring-zinc-400/40',
  danger:
    'bg-red-600 text-white hover:bg-red-500 focus-visible:ring-red-400/40',
  ghost:
    'bg-transparent text-zinc-300 hover:bg-zinc-800 hover:text-zinc-100 focus-visible:ring-zinc-400/30',
  success:
    'bg-emerald-600 text-white hover:bg-emerald-500 focus-visible:ring-emerald-400/40',
};

const SIZE_CLASSES: Record<LxButtonSize, string> = {
  sm: 'px-2.5 py-1 text-xs',
  md: 'px-3 py-1.5 text-sm',
};

/**
 * Minimal, opinionated button. Keep variants tight — extend only when a
 * concrete second use case appears.
 */
@Component({
  selector: 'button[lx-button]',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    type: 'button',
    '[class]': 'classes()',
    '[disabled]': 'disabled() || null',
  },
  template: `<ng-content />`,
})
export class LxButton {
  readonly variant = input<LxButtonVariant>('secondary');
  readonly size = input<LxButtonSize>('md');
  readonly disabled = input<boolean>(false);

  protected readonly classes = computed(
    () =>
      'inline-flex items-center gap-1.5 rounded font-medium transition-colors ' +
      'focus-visible:outline-none focus-visible:ring-2 ' +
      'disabled:cursor-not-allowed disabled:opacity-50 ' +
      `${SIZE_CLASSES[this.size()]} ${VARIANT_CLASSES[this.variant()]}`,
  );
}
