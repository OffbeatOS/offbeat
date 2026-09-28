import { ChangeDetectionStrategy, Component, DestroyRef, effect, inject } from '@angular/core';
import { Router, RouterOutlet } from '@angular/router';
import { ActivityStore } from '../../core/activity-store';
import { Session } from '../../core/session';
import { SETTINGS_SECTIONS } from '../../features/settings/sections';
import { BottomBar } from './bottom-bar';
import { Sidebar } from './sidebar';
import { TabBar } from './tab-bar';

/** Settings sections only admins may open. */
const ADMIN_SETTINGS = SETTINGS_SECTIONS.filter((s) => s.admin).map((s) => `/settings/${s.path}`);

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
        // Room for the tab bar and the floating mini bar above it.
        padding-bottom: calc(var(--tab-bar-height) + env(safe-area-inset-bottom) + 76px);
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
export class ShellLayout {
  constructor() {
    // One live activity stream for as long as the signed-in shell is on screen.
    inject(DestroyRef).onDestroy(inject(ActivityStore).connect());

    // Role, permissions, or password changed by an admin while this page is open:
    // leave what is no longer allowed. Buttons follow on their own (Session.can).
    const session = inject(Session);
    const router = inject(Router);
    effect(() => {
      const user = session.user();
      if (!user) return;
      if (user.mustChangePassword) {
        void router.navigateByUrl('/change-password');
      } else if (user.role !== 'admin' && ADMIN_SETTINGS.some((path) => router.url.startsWith(path))) {
        void router.navigateByUrl('/settings/discovery');
      }
    });

    // Coming back to the tab is a good moment to check (at most every 30 seconds).
    const onVisible = () => {
      if (document.visibilityState === 'visible') void session.refresh(30_000);
    };
    document.addEventListener('visibilitychange', onVisible);
    inject(DestroyRef).onDestroy(() => document.removeEventListener('visibilitychange', onVisible));
  }
}
