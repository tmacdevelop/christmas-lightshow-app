import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { AppBarComponent } from '../app-bar/app-bar.component';
import { AudioPanelComponent } from '../audio-panel/audio-panel.component';
import { ControlPanelComponent } from '../control-panel/control-panel.component';
import { LayoutDesignerComponent } from '../layout-designer/layout-designer.component';
import { MusicConsoleComponent } from '../music-console/music-console.component';
import { SimulatorComponent } from '../simulator/simulator.component';
import { TimelineComponent } from '../timeline/timeline.component';
import { LxPanel } from '../../ui-components/panel/lx-panel';
import { LxSplitter } from '../../ui-components/splitter/lx-splitter';
import { LxTab, LxTabs } from '../../ui-components/tabs/lx-tabs';
import { SpotifyPanelComponent } from '../spotify-panel/spotify-panel.component';
import { StatusSocketService } from '../../services/status-socket.service';
import { persistedSignal, clampNumber } from '../../util/persisted-signal';

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
    MusicConsoleComponent,
    SimulatorComponent,
    SpotifyPanelComponent,
    TimelineComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    class:
      'flex min-h-screen w-full flex-col overflow-x-hidden bg-zinc-950 text-zinc-100 pb-16',
  },
  templateUrl: './workspace.component.html',
})
export class WorkspaceComponent {
  // Injecting StatusSocketService here starts the WebSocket connection for the
  // entire app lifetime — no component needs to poll /api/status anymore.
  private readonly _statusSocket = inject(StatusSocketService);

  /** Active stage tab (0=Simulator,1=Designer,2=Music,3=Spotify). Persisted. */
  protected readonly activeTab = persistedSignal('ws.activeTab', 0, {
    sanitize: (v) =>
      typeof v === 'number' && v >= 0 && v <= 3 ? Math.floor(v) : undefined,
  });
  /** Stage height in px; user can drag the gutter to adjust. Persisted. */
  protected readonly stageSize = persistedSignal('ws.stageSize', 520, {
    sanitize: clampNumber(240, 2000),
  });
  /** Live Control pane width in px. Persisted. */
  protected readonly controlWidth = persistedSignal('ws.controlWidth', 360, {
    sanitize: clampNumber(280, 520),
  });
  /**
   * Minimum height for the splittered workspace area. When the viewport is
   * shorter than this (app bar ~48 + this), the page scrolls vertically so
   * the bottom dock stays usable on small windows.
   */
  protected readonly minWorkspaceHeight = 760;
}
