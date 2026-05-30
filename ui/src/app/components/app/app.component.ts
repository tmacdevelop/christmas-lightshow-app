import { ChangeDetectionStrategy, Component, signal } from '@angular/core';

import { SimulatorComponent } from '../simulator/simulator.component';
import { WorkspaceComponent } from '../workspace/workspace.component';

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
  templateUrl: './app.component.html',
  styleUrl: './app.component.css',
})
export class App {
  protected readonly view = signal(readView());
}
