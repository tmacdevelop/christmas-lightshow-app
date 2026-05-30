import {
  ChangeDetectionStrategy,
  Component,
  OnInit,
  computed,
  inject,
  signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ShowControlService } from '../../services/show-control.service';
import { LxButton } from '../../ui-components/button/lx-button';

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
  templateUrl: './app-bar.component.html',
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
