import { ChangeDetectionStrategy, Component, signal } from '@angular/core';

import { SimulatorComponent } from './app-components/simulator';
import { WorkspaceComponent } from './shell/workspace';

/**
 * The window can be opened in two views:
 *  - default: the full workspace (shell + designer + timeline + simulator).
 *  - `?view=simulator`: just the simulator, fullscreen — used for the pop-out
 *    window so the user can drag it to a second monitor.
 */
function readView(): 'workspace' | 'simulator' {
  if (typeof window === 'undefined') return 'workspace';
  const params = new URLSearchParams(window.location.search);
  return params.get('view') === 'simulator' ? 'simulator' : 'workspace';
}

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [WorkspaceComponent, SimulatorComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (view() === 'simulator') {
      <app-simulator variant="popout" class="block h-screen w-screen bg-black" />
    } @else {
      <app-workspace />
    }
  `,
  styles: [
    `
      :host {
        display: block;
        height: 100%;
      }
    `,
  ],
})
export class App {
  protected readonly view = signal(readView());
}
