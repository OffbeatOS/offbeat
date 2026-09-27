import { ChangeDetectionStrategy, Component } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { BottomBar } from './bottom-bar';
import { Sidebar } from './sidebar';
import { TabBar } from './tab-bar';

/**
 * App shell for signed-in pages: sidebar, routed content, and the bottom bar.
 * Pages render in the inner outlet; the bottom bar sits outside it so it (and
 * the phase 5 player) survives navigation between them.
 */
@Component({
  selector: 'ob-shell-layout',
  imports: [RouterOutlet, Sidebar, BottomBar, TabBar],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: `
    @use '../mixins';

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
export class ShellLayout {}
