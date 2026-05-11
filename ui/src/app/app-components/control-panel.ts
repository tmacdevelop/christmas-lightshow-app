import {
  ChangeDetectionStrategy,
  Component,
  OnInit,
  computed,
  inject,
  signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';

import { ShowControlService } from '../services/show-control.service';
import { MicBeatService } from '../services/mic-beat.service';
import { EffectKind } from '../models/show.models';

@Component({
  selector: 'app-control-panel',
  standalone: true,
  imports: [FormsModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './control-panel.html',
  styleUrl: './control-panel.css',
})
export class ControlPanelComponent implements OnInit {
  private readonly control = inject(ShowControlService);
  protected readonly mic = inject(MicBeatService);

  protected readonly status = this.control.status;
  protected readonly effects = this.control.effects;
  protected readonly lastError = this.control.lastError;

  // Local "draft" inputs so sliders/pickers feel responsive while we POST.
  protected readonly colorDraft = signal<string>('#ff0000');
  protected readonly brightnessDraft = signal<number>(1.0);

  protected readonly playing = computed(() => this.status()?.playing ?? false);
  protected readonly activeEffect = computed(() => this.status()?.effect ?? null);
  protected readonly brightnessPercent = computed(() =>
    Math.round(this.brightnessDraft() * 100),
  );

  async ngOnInit(): Promise<void> {
    await this.control.refresh();
    const s = this.status();
    if (s) {
      this.colorDraft.set(s.color.hex);
      this.brightnessDraft.set(s.brightness);
    }
  }

  protected async start(): Promise<void> {
    await this.control.start();
  }

  protected async stop(): Promise<void> {
    await this.control.stop();
  }

  protected async chooseEffect(kind: EffectKind): Promise<void> {
    await this.control.setEffect(kind);
  }

  protected onColorInput(hex: string): void {
    this.colorDraft.set(hex);
  }

  protected async commitColor(): Promise<void> {
    await this.control.setColorHex(this.colorDraft());
  }

  protected onBrightnessInput(value: number): void {
    this.brightnessDraft.set(value);
  }

  protected async commitBrightness(): Promise<void> {
    await this.control.setBrightness(this.brightnessDraft());
  }

  protected async toggleMic(): Promise<void> {
    if (this.mic.running()) {
      await this.mic.stop();
    } else {
      try {
        await this.mic.start();
      } catch {
        /* lastError set inside the service */
      }
    }
  }

  protected onThresholdInput(value: number): void {
    this.mic.threshold.set(value);
  }
}
