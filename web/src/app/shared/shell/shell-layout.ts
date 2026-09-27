import { ChangeDetectionStrategy, Component } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { BottomBar } from './shared/shell/bottom-bar';
import { Sidebar } from './shared/shell/sidebar';
import { TabBar } from './shared/shell/tab-bar';

/**
 * App shell: sidebar, routed content, and the bottom bar. The bottom bar sits
 * outside the router outlet so it (and the phase 5 player) survives navigation.
 */
@Component({
  selector: 'ob-root',
  imports: [RouterOutlet, Sidebar, BottomBar, TabBar],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: `
    @use './shared/mixins';

    :host {
      display: grid;
      grid-template-columns: var(--sidebar-width) minmax(0, 1fr);
      grid-template-rows: minmax(0, 1fr) var(--bar-height);
      height: 100vh;
      height: 100dvh;
    }

    ob-sidebar {
      grid-row: 1;
    }

    main {
      grid-row: 1;
      overflow-y: auto;
    }

    ob-bottom-bar {
      grid-column: 1 / -1;
      grid-row: 2;
    }

    @include mixins.mobile {
      :host {
        display: block;
        height: auto;
        min-height: 100dvh;
      }

      ob-sidebar {
        display: none;
      }

      main {
        overflow: visible;
        padding-bottom: calc(var(--tab-bar-height) + env(safe-area-inset-bottom));
      }
    }
  `,
  template: `
    <ob-sidebar />
    <main>
      <router-outlet />
    </main>
    <ob-bottom-bar />
    <ob-tab-bar />
  `,
})
export class App {}
