import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
} from '@angular/core';

/**
 * Square button used in toolbars and overlays. Holds an icon (text glyph,
 * inline SVG, or material symbol) projected via content.
 */
@Component({
  selector: 'button[lx-icon-button]',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    type: 'button',
    '[class]': 'classes()',
    '[disabled]': 'disabled() || null',
    '[attr.aria-label]': 'label() || null',
    '[attr.title]': 'label() || null',
  },
  template: `<ng-content />`,
})
export class LxIconButton {
  readonly label = input<string>('');
  readonly disabled = input<boolean>(false);
  readonly toggled = input<boolean>(false);

  protected readonly classes = computed(() => {
    const base =
      'inline-flex h-8 w-8 items-center justify-center rounded text-sm ' +
      'transition-colors focus-visible:outline-none focus-visible:ring-2 ' +
      'focus-visible:ring-zinc-400/40 disabled:cursor-not-allowed ' +
      'disabled:opacity-40';
    return this.toggled()
      ? `${base} bg-emerald-600/20 text-emerald-200`
      : `${base} bg-transparent text-zinc-300 hover:bg-zinc-800 hover:text-zinc-100`;
  });
}
