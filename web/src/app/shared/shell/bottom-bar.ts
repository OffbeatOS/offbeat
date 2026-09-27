import { ChangeDetectionStrategy, Component } from '@angular/core';
import { RouterLink } from '@angular/router';

/**
 * Persistent bar below the router outlet. Shows download activity in phases
 * 1 to 4 and becomes the audio player in phase 5, which is why it lives in the
 * app shell rather than inside any routed page.
 *
 * On mobile it collapses to the floating mini bar above the tab bar, and is
 * hidden entirely while idle.
 */
@Component({
  selector: 'ob-bottom-bar',
  imports: [RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: `
    @use '../mixins';

    :host {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 24px;
      padding: 0 28px;
      background: var(--bg-bar);
      border-top: 1px solid var(--border-bar);
      font-size: 13px;
    }

    .idle {
      color: var(--text-3);
    }

    .link {
      font-weight: 600;
    }

    @include mixins.mobile {
      :host {
        display: none;
      }
    }
  `,
  template: `
    <span class="idle">No downloads in progress</span>
    <a class="link" routerLink="/activity">View activity</a>
  `,
})
export class BottomBar {}
