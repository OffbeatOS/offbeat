import { ChangeDetectionStrategy, Component } from '@angular/core';
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';

export const SETTINGS_SECTIONS = [
  { path: 'integrations', label: 'Integrations' },
  { path: 'discovery', label: 'Discovery' },
  { path: 'users', label: 'Users' },
  { path: 'account', label: 'Account' },
  { path: 'notifications', label: 'Notifications' },
  { path: 'about', label: 'About' },
] as const;

/** Settings mockup: title and section list on the left, section on the right. */
@Component({
  selector: 'ob-settings-layout',
  imports: [RouterLink, RouterLinkActive, RouterOutlet],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: `
    @use '../../shared/mixins';

    :host {
      display: grid;
      grid-template-columns: 200px minmax(0, 1fr);
      column-gap: 56px;
      padding: var(--page-pad-top) var(--page-pad-x) 48px;
    }

    aside {
      display: flex;
      flex-direction: column;
      gap: 24px;
    }

    h1 {
      @include mixins.text-page-title;
    }

    nav {
      display: flex;
      flex-direction: column;
      gap: 2px;
    }

    nav a {
      padding: 9px 12px;
      border-radius: var(--radius-nav);
      color: var(--text-2);
      font-size: 14px;
      font-weight: 500;

      &:hover {
        color: var(--text);
      }

      &.active {
        background: var(--surface-2);
        color: var(--text);
        font-weight: 600;
      }
    }

    .section {
      padding-top: 6px;
      max-width: 820px;
    }

    @include mixins.mobile {
      :host {
        grid-template-columns: minmax(0, 1fr);
        row-gap: 28px;
        padding: 60px 20px 32px;
      }

      h1 {
        font-size: 32px;
      }

      nav {
        flex-direction: row;
        overflow-x: auto;
        margin-right: -20px;
      }

      nav a {
        flex-shrink: 0;
      }
    }
  `,
  template: `
    <aside>
      <h1>Settings</h1>
      <nav aria-label="Settings">
        @for (section of sections; track section.path) {
          <a [routerLink]="section.path" routerLinkActive="active" ariaCurrentWhenActive="page">
            {{ section.label }}
          </a>
        }
      </nav>
    </aside>
    <div class="section">
      <router-outlet />
    </div>
  `,
})
export class SettingsLayout {
  protected readonly sections = SETTINGS_SECTIONS;
}
