import {
  ChangeDetectionStrategy,
  Component,
  Directive,
  TemplateRef,
  contentChildren,
  inject,
  input,
  model,
} from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';

/**
 * Tab definition. Use as a structural directive on `<ng-template>`:
 *
 *   <lx-tabs>
 *     <ng-template lxTab label="Simulator">…</ng-template>
 *     <ng-template lxTab label="Designer">…</ng-template>
 *   </lx-tabs>
 *
 * A directive on `<ng-template>` is required so we can capture the body as
 * a `TemplateRef` without rendering it eagerly (and `inject(TemplateRef)`
 * only works on directives, not components).
 */
@Directive({
  selector: 'ng-template[lxTab]',
  standalone: true,
})
export class LxTab {
  readonly label = input.required<string>();
  readonly content = inject(TemplateRef);
}

@Component({
  selector: 'lx-tabs',
  standalone: true,
  imports: [NgTemplateOutlet],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    class: 'flex h-full min-h-0 min-w-0 flex-col',
  },
  template: `
    <div
      role="tablist"
      class="flex shrink-0 gap-1 border-b border-zinc-800 px-2 pt-1"
    >
      @for (tab of tabs(); track $index; let i = $index) {
        <button
          type="button"
          role="tab"
          [attr.aria-selected]="i === active()"
          [attr.tabindex]="i === active() ? 0 : -1"
          class="rounded-t px-3 py-1.5 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400/40"
          [class.bg-zinc-900]="i === active()"
          [class.text-emerald-200]="i === active()"
          [class.text-zinc-400]="i !== active()"
          [class.hover:text-zinc-100]="i !== active()"
          (click)="active.set(i)"
        >
          {{ tab.label() }}
        </button>
      }
      <div class="flex-1"></div>
      <ng-content select="[tabs-actions]" />
    </div>
    <div class="min-h-0 min-w-0 flex-1 overflow-hidden">
      @for (tab of tabs(); track $index; let i = $index) {
        <div
          class="h-full"
          [class.hidden]="i !== active()"
          role="tabpanel"
        >
          <ng-container [ngTemplateOutlet]="tab.content" />
        </div>
      }
    </div>
  `,
})
export class LxTabs {
  readonly active = model<number>(0);
  readonly tabs = contentChildren(LxTab);
}
