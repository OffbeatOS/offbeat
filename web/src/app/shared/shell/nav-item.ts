import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { RouterLink, RouterLinkActive } from '@angular/router';
import type { NavItem as NavItemConfig } from '../../core/navigation';
import { Icon } from '../icon/icon';

/** Sidebar link. Active state: raised pill, accent icon, primary label. */
@Component({
  selector: 'ob-nav-item',
  imports: [RouterLink, RouterLinkActive, Icon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: `
    a {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 9px 12px;
      border-radius: var(--radius-nav);
      color: var(--text-2);
      font-size: 14px;
      font-weight: 500;
      transition:
        background-color 120ms ease,
        color 120ms ease;

      &:hover {
        color: var(--text);
        background: var(--surface-2);
      }

      &.active {
        background: var(--surface-3);
        color: var(--accent);
        font-weight: 600;

        .label {
          color: var(--text);
        }
      }
    }
  `,
  template: `
    <a [routerLink]="item().path" routerLinkActive="active" ariaCurrentWhenActive="page">
      <ob-icon [name]="item().icon" />
      <span class="label">{{ item().label }}</span>
    </a>
  `,
})
export class NavItem {
  readonly item = input.required<NavItemConfig>();
}
