import { Component } from '@angular/core';

import { SimulatorComponent } from './simulator';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [SimulatorComponent],
  template: `<app-simulator></app-simulator>`,
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
