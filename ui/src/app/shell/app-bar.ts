import {
  ChangeDetectionStrategy,
  Component,
  OnInit,
  computed,
  inject,
  signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ShowControlService } from '../show-control.service';
import { LxButton } from '../ui-components/button/lx-button';

/**
 * Always-visible top bar. Shows global status + global transport (start/stop)
 * + a small slot for tab-specific actions via [appbar-actions].
 */
@Component({
  selector: 'app-app-bar',
  standalone: true,
  imports: [FormsModule, LxButton],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    class:
      'flex shrink-0 items-center gap-3 border-b border-zinc-800 bg-zinc-950/95 px-4 py-2',
  },
  template: `
    <div class="flex items-center gap-2">
      <span class="text-base">🎄</span>
      <h1 class="text-sm font-semibold tracking-tight text-zinc-100">
        Christmas Light Show
      </h1>
    </div>

    <span
      class="ml-2 inline-flex items-center gap-2 rounded-full bg-zinc-900 px-2.5 py-0.5 text-xs"
      [attr.title]="playing() ? 'Show is playing' : 'Show is stopped'"
    >
      <span
        class="h-2 w-2 rounded-full"
        [class.bg-emerald-500]="playing()"
        [class.bg-zinc-600]="!playing()"
      ></span>
      <span class="text-zinc-300">
        {{ playing() ? 'Playing' : 'Stopped' }}
      </span>
    </span>

    <ng-content select="[appbar-actions]" />

    <div class="ml-auto flex items-center gap-2">
      <button
        lx-button
        variant="success"
        size="sm"
        [disabled]="playing()"
        (click)="start()"
      >
        ▶ Start
      </button>
      <button
        lx-button
        variant="secondary"
        size="sm"
        [disabled]="!playing()"
        (click)="stop()"
      >
        ■ Stop
      </button>
    </div>
  `,
})
export class AppBarComponent implements OnInit {
  private readonly control = inject(ShowControlService);

  protected readonly status = this.control.status;
  protected readonly playing = computed(() => this.status()?.playing ?? false);

  async ngOnInit(): Promise<void> {
    await this.control.refresh();
  }

  protected async start(): Promise<void> {
    await this.control.start();
  }

  protected async stop(): Promise<void> {
    await this.control.stop();
  }
}
