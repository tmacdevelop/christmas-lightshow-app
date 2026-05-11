import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { AppBarComponent } from './app-bar';
import { AudioPanelComponent } from '../app-components/audio-panel';
import { ControlPanelComponent } from '../app-components/control-panel';
import { LayoutDesignerComponent } from '../app-components/layout-designer';
import { SimulatorComponent } from '../app-components/simulator';
import { TimelineComponent } from '../app-components/timeline';
import { LxPanel } from '../ui-components/panel/lx-panel';
import { LxSplitter } from '../ui-components/splitter/lx-splitter';
import { LxTab, LxTabs } from '../ui-components/tabs/lx-tabs';
import { SpotifyPanelComponent } from '../app-components/spotify-panel';
import { StatusSocketService } from '../services/status-socket.service';

/**
 * Single-screen workspace shell (Option A).
 *
 * ┌────────────────── App Bar ──────────────────┐
 * │ status · transport                          │
 * ├─────────────────────────────────────────────┤
 * │  Stage tabs: [Simulator] [Designer]         │
 * │  ┌───────────────────────────────────────┐  │
 * │  │            active tab body            │  │
 * │  └───────────────────────────────────────┘  │
 * ├─────── splitter (vertical drag) ────────────┤
 * │  Bottom dock:                               │
 * │  [ Live Control ]  ↔  [ Timeline ]          │
 * └─────────────────────────────────────────────┘
 */
@Component({
  selector: 'app-workspace',
  standalone: true,
  imports: [
    AppBarComponent,
    AudioPanelComponent,
    ControlPanelComponent,
    LayoutDesignerComponent,
    LxPanel,
    LxSplitter,
    LxTab,
    LxTabs,
    SimulatorComponent,
    SpotifyPanelComponent,
    TimelineComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    class:
      'flex min-h-screen w-screen flex-col bg-zinc-950 text-zinc-100',
  },
  template: `
    <app-app-bar />

    <div
      class="flex min-h-0 flex-1 flex-col"
      [style.min-height.px]="minWorkspaceHeight"
    >
      <lx-splitter orientation="vertical" [size]="stageSize" [min]="240">
        <!-- Stage: tabs hosting Simulator / Designer -->
        <div lx-splitter-pane="first" class="h-full p-2">
          <lx-panel [scroll]="false">
            <lx-tabs>
              <ng-template lxTab label="Simulator">
                <div class="h-full p-3">
                  <app-simulator class="block h-full" />
                </div>
              </ng-template>
              <ng-template lxTab label="Designer">
                <div class="h-full">
                  <app-layout-designer class="block h-full" />
                </div>
              </ng-template>
              <ng-template lxTab label="Music">
                <div class="h-full overflow-auto p-3">
                  <app-audio-panel />
                </div>
              </ng-template>
              <ng-template lxTab label="Spotify">
                <div class="h-full overflow-auto p-3">
                  <app-spotify-panel />
                </div>
              </ng-template>
            </lx-tabs>
          </lx-panel>
        </div>

        <!-- Bottom dock: live control + timeline, side by side -->
        <div lx-splitter-pane="second" class="h-full p-2 pt-0">
          <lx-splitter [size]="controlWidth" [min]="280" [max]="520">
            <div lx-splitter-pane="first" class="h-full pr-1">
              <lx-panel heading="Live Control">
                <div class="p-3">
                  <app-control-panel />
                </div>
              </lx-panel>
            </div>
            <div lx-splitter-pane="second" class="h-full pl-1">
              <lx-panel heading="Timeline" [scroll]="false">
                <div class="h-full overflow-auto p-3">
                  <app-timeline />
                </div>
              </lx-panel>
            </div>
          </lx-splitter>
        </div>
      </lx-splitter>
    </div>
  `,
})
export class WorkspaceComponent {
  // Injecting StatusSocketService here starts the WebSocket connection for the
  // entire app lifetime — no component needs to poll /api/status anymore.
  private readonly _statusSocket = inject(StatusSocketService);

  /** Initial stage height in px; user can drag the gutter to adjust. */
  protected stageSize = 520;
  protected controlWidth = 360;
  /**
   * Minimum height for the splittered workspace area. When the viewport is
   * shorter than this (app bar ~48 + this), the page scrolls vertically so
   * the bottom dock stays usable on small windows.
   */
  protected readonly minWorkspaceHeight = 760;
}
