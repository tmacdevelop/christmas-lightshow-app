import { Component } from '@angular/core';

import { ControlPanelComponent } from './control-panel';
import { SimulatorComponent } from './simulator';
import { TimelineComponent } from './timeline';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [SimulatorComponent, ControlPanelComponent, TimelineComponent],
  template: `
    <div class="flex h-full min-h-screen flex-col gap-4 bg-zinc-950 p-6 text-zinc-100">
      <app-simulator class="flex-1"></app-simulator>
      <app-control-panel></app-control-panel>
      <app-timeline></app-timeline>
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
