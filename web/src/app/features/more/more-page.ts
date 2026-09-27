import { ChangeDetectionStrategy, Component } from '@angular/core';
import { RouterLink } from '@angular/router';
import { MORE_NAV } from '../../core/navigation';
import { Icon } from '../../shared/icon/icon';
import { Page } from '../../shared/page/page';

/** Mobile overflow menu for destinations that do not fit in the tab bar. */
@Component({
  selector: 'ob-more-page',
  imports: [RouterLink, Icon, Page],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: `
    ul {
      list-style: none;
      margin: 0;
      padding: 0;
    }

    a {
      display: flex;
      align-items: center;
      gap: 14px;
      min-height: 56px;
      border-bottom: 1px solid var(--divider);
      font-size: 15px;
      font-weight: 500;
    }

    .lead {
      color: var(--text-2);
    }

    .label {
      flex-grow: 1;
    }

    .chevron {
      color: var(--text-4);
    }
  `,
  template: `
    <ob-page heading="More">
      <ul>
        @for (item of items; track item.path) {
          <li>
            <a [routerLink]="item.path">
              <ob-icon class="lead" [name]="item.icon" [size]="22" />
              <span class="label">{{ item.label }}</span>
              <ob-icon class="chevron" name="chevron-right" [size]="18" />
            </a>
          </li>
        }
      </ul>
    </ob-page>
  `,
})
export class MorePage {
  protected readonly items = MORE_NAV;
}
