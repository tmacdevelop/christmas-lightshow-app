import { Component } from '@angular/core';

import { ControlPanelComponent } from './control-panel';
import { SimulatorComponent } from './simulator';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [SimulatorComponent, ControlPanelComponent],
  template: `
    <div class="flex h-full min-h-screen flex-col gap-4 bg-zinc-950 p-6 text-zinc-100">
      <app-simulator class="flex-1"></app-simulator>
      <app-control-panel></app-control-panel>
    </div>
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
export class App {}
