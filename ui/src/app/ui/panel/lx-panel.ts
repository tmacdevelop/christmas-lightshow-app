import { ChangeDetectionStrategy, Component, input } from '@angular/core';

/**
 * Panel = header + scrollable body. The host fills its container so panels
 * can be dropped into flex/grid slots without each one needing its own
 * sizing rules. Use `dense` to drop the header padding on toolbar-style
 * panels.
 */
@Component({
  selector: 'lx-panel',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    class:
      'flex h-full min-h-0 min-w-0 flex-col overflow-hidden rounded-lg border border-zinc-800 bg-zinc-900/60',
  },
  template: `
    @if (heading() || hasHeaderSlot) {
      <header
        class="flex items-center gap-2 border-b border-zinc-800 px-3"
        [class.py-1]="dense()"
        [class.py-2]="!dense()"
      >
        @if (heading()) {
          <h2 class="text-sm font-semibold tracking-tight text-zinc-100">
            {{ heading() }}
          </h2>
        }
        <ng-content select="[panel-actions]" />
      </header>
    }
    <div
      class="min-h-0 min-w-0 flex-1"
      [class.overflow-auto]="scroll()"
      [class.overflow-hidden]="!scroll()"
    >
      <ng-content />
    </div>
  `,
})
export class LxPanel {
  readonly heading = input<string>('');
  readonly dense = input<boolean>(false);
  readonly scroll = input<boolean>(true);

  // Header is shown if heading() is set; we don't try to detect projected
  // content (overkill). Consumers needing a header without a title can pass
  // a single space.
  protected readonly hasHeaderSlot = false;
}
