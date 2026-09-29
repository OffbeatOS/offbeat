import { ChangeDetectionStrategy, Component, DestroyRef, effect, inject } from '@angular/core';
import { Router, RouterOutlet } from '@angular/router';
import { ActivityStore } from '../../core/activity-store';
import { Player } from '../../core/player';
import { Session } from '../../core/session';
import { SETTINGS_SECTIONS } from '../../features/settings/sections';
import { NowPlaying } from '../player/now-playing';
import { QueueList } from '../player/queue-list';
import { BottomBar } from './bottom-bar';
import { PlayerBar } from './player-bar';
import { Sidebar } from './sidebar';
import { TabBar } from './tab-bar';

/** Settings sections only admins may open. */
const ADMIN_SETTINGS = SETTINGS_SECTIONS.filter((s) => s.admin).map((s) => `/settings/${s.path}`);

/**
 * App shell for signed-in pages: sidebar, routed content, and the bottom bar.
 * Pages render in the inner outlet; the bottom bar sits outside it so the
 * player survives navigation between them. Until something is queued, the
 * bar shows download activity. The queue drawer and Now Playing open over
 * the page, and space and the left and right arrows control playback.
 */
@Component({
  selector: 'ob-shell-layout',
  imports: [RouterOutlet, Sidebar, BottomBar, PlayerBar, QueueList, NowPlaying, TabBar],
  host: { '(document:keydown)': 'shortcut($event)' },
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: `
    @use '../mixins';

    :host {
      position: relative;
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

    ob-bottom-bar,
    ob-player-bar {
      grid-column: 1 / -1;
      grid-row: 2;
    }

    // Queue drawer (Playing mockup): over the page, above the player.
    .queue {
      position: absolute;
      top: 0;
      right: 0;
      bottom: var(--bar-height);
      z-index: 5;
      width: 380px;
      padding: 28px 22px;
      display: flex;
      flex-direction: column;
      gap: 18px;
      overflow-y: auto;
      background: #18181b;
      border-left: 1px solid var(--border-bar);
      box-shadow: -24px 0 48px rgba(0, 0, 0, 0.35);
    }

    .queue-head {
      display: flex;
      align-items: center;
      justify-content: space-between;

      h2 {
        font-size: 20px;
        font-weight: 600;
        letter-spacing: -0.01em;
      }
    }

    .clear {
      height: 30px;
      padding: 0 12px;
      border: 0;
      border-radius: 15px;
      background: var(--surface-3);
      color: var(--text-soft);
      font-size: 12px;
      font-weight: 600;

      &:hover:not(:disabled) {
        background: var(--surface-4);
      }
    }

    @include mixins.mobile {
      :host {
        display: block;
        height: auto;
        min-height: 100dvh;
      }

      ob-sidebar,
      .queue {
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
    @if (player.active()) {
      <ob-player-bar />
    } @else {
      <ob-bottom-bar />
    }
    @if (player.active() && player.queueOpen()) {
      <aside class="queue" aria-label="Queue">
        <div class="queue-head">
          <h2>Queue</h2>
          <button class="clear" type="button" [disabled]="!player.added().length && !player.upNext().length" (click)="player.clearQueue()">Clear</button>
        </div>
        <ob-queue-list />
      </aside>
    }
    <ob-tab-bar />
    @if (player.active() && player.nowPlayingOpen()) {
      <ob-now-playing />
    }
  `,
})
export class ShellLayout {
  protected readonly player = inject(Player);

  constructor() {
    // Signing out (or leaving the signed-in app) ends playback.
    inject(DestroyRef).onDestroy(() => this.player.stop());

    // One live activity stream for as long as the signed-in shell is on screen.
    inject(DestroyRef).onDestroy(inject(ActivityStore).connect());

    // Role, permissions, or password changed by an admin while this page is open:
    // leave what is no longer allowed. Buttons follow on their own (Session.can).
    const session = inject(Session);
    const router = inject(Router);
    effect(() => {
      const user = session.user();
      if (!user) return;
      if (user.mustChangePassword && session.via() === 'password') {
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

  /** Space plays and pauses; the left and right arrows seek 10 seconds. Never while typing or on a control. */
  protected shortcut(event: KeyboardEvent) {
    if (!this.player.active() || event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return;
    const target = event.target instanceof HTMLElement ? event.target : null;
    if (target?.closest('input, textarea, select, [contenteditable="true"], [role="slider"], [role="menu"], .cdk-drag-handle')) return;
    if (event.key === ' ') {
      // Space on a button or link presses it; do not also play or pause.
      if (target?.closest('button, a, summary, [role="button"]')) return;
      event.preventDefault();
      this.player.toggle();
    } else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault();
      this.player.seek(this.player.position() + (event.key === 'ArrowLeft' ? -10 : 10));
    }
  }
}
