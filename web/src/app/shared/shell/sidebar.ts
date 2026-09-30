import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { ActivityStore } from '../../core/activity-store';
import { PRIMARY_NAV, SECONDARY_NAV } from '../../core/navigation';
import { Wordmark } from '../wordmark/wordmark';
import { NavItem } from './nav-item';

@Component({
  selector: 'ob-sidebar',
  imports: [RouterLink, NavItem, Wordmark],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: `
    :host {
      display: block;
      background: var(--bg-sidebar);
      border-right: 1px solid var(--border-sidebar);
      overflow-y: auto;
    }

    nav {
      min-height: 100%;
      padding: 28px 14px;
      display: flex;
      flex-direction: column;
      gap: 28px;
    }

    .brand {
      padding: 0 12px;
    }

    .group {
      display: flex;
      flex-direction: column;
      gap: 2px;
    }

    .spacer {
      flex-grow: 1;
    }
  `,
  template: `
    <nav aria-label="Main">
      <a class="brand" routerLink="/discover"><ob-wordmark /></a>

      <div class="group">
        @for (item of primary; track item.path) {
          @if (item.path === '/activity') {
            <ob-nav-item [item]="item" [badge]="downloads()" [badgeLabel]="downloadsLabel()" />
          } @else {
            <ob-nav-item [item]="item" />
          }
        }
      </div>

      <div class="spacer"></div>

      <div class="group">
        @for (item of secondary; track item.path) {
          <ob-nav-item [item]="item" />
        }
      </div>
    </nav>
  `,
})
export class Sidebar {
  /** Downloads in progress, on the Activity item (the bottom bar may be the player). */
  protected readonly downloads = inject(ActivityStore).inProgressCount;
  protected readonly downloadsLabel = computed(() => `${this.downloads()} ${this.downloads() === 1 ? 'download' : 'downloads'} in progress`);
  protected readonly primary = PRIMARY_NAV;
  protected readonly secondary = SECONDARY_NAV;
}
