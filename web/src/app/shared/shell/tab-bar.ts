import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { NavigationEnd, Router, RouterLink, RouterLinkActive } from '@angular/router';
import { filter, map } from 'rxjs';
import { ActivityStore } from '../../core/activity-store';
import { MORE_NAV, TAB_NAV } from '../../core/navigation';
import { Icon } from '../icon/icon';

/** Mobile replacement for the sidebar. Hidden on desktop. */
@Component({
  selector: 'ob-tab-bar',
  imports: [RouterLink, RouterLinkActive, Icon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: `
    @use '../mixins';

    :host {
      display: none;
    }

    @include mixins.mobile {
      :host {
        display: block;
        position: fixed;
        inset: auto 0 0 0;
        z-index: 10;
        background: var(--bg-sidebar);
        border-top: 1px solid var(--border-bar);
        padding-bottom: env(safe-area-inset-bottom);
      }
    }

    nav {
      height: var(--tab-bar-height);
      display: grid;
      grid-template-columns: repeat(5, minmax(0, 1fr));
      padding-top: 8px;
    }

    a {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 4px;
      min-height: var(--touch-target);
      color: var(--text-3);
      font-size: 10px;
      font-weight: 500;

      .icon {
        position: relative;
        display: flex;
      }

      .dot {
        position: absolute;
        top: -2px;
        right: -6px;
        width: 8px;
        height: 8px;
        border-radius: 50%;
        background: var(--status-progress);
      }

      &.active {
        color: var(--accent);
        font-weight: 600;
      }
    }
  `,
  template: `
    <nav aria-label="Main">
      @for (item of items; track item.path) {
        <a
          [routerLink]="item.path"
          routerLinkActive="active"
          ariaCurrentWhenActive="page"
          [class.active]="item.path === '/more' && inMoreSection()"
        >
          <span class="icon">
            <ob-icon [name]="item.icon" [size]="24" />
            @if (item.path === '/activity' && downloads()) {
              <span class="dot" role="img" aria-label="Downloads in progress"></span>
            }
          </span>
          {{ item.label }}
        </a>
      }
    </nav>
  `,
})
export class TabBar {
  protected readonly items = TAB_NAV;
  /** Downloads in progress: a blue dot on Activity (MobilePlaying mockup). */
  protected readonly downloads = inject(ActivityStore).inProgressCount;

  private readonly router = inject(Router);
  private readonly url = toSignal(
    this.router.events.pipe(
      filter((event) => event instanceof NavigationEnd),
      map(() => this.router.url),
    ),
    { initialValue: this.router.url },
  );

  /** Keeps More highlighted on the pages it links to (Settings). */
  protected readonly inMoreSection = computed(() => {
    const url = this.url();
    return MORE_NAV.some((item) => url === item.path || url.startsWith(`${item.path}/`));
  });
}
