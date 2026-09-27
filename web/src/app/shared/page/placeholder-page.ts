import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { EmptyState } from '../empty-state/empty-state';
import type { IconName } from '../icon/icon';
import { Page } from './page';

/**
 * Stand-in for screens that later phases build out. Route data supplies the
 * copy through component input binding.
 */
@Component({
  selector: 'ob-placeholder-page',
  imports: [Page, EmptyState],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <ob-page [heading]="heading()">
      <ob-empty-state [icon]="icon()" [heading]="emptyHeading()" [message]="emptyMessage()" />
    </ob-page>
  `,
})
export class PlaceholderPage {
  readonly heading = input.required<string>();
  readonly icon = input.required<IconName>();
  readonly emptyHeading = input.required<string>();
  readonly emptyMessage = input<string>();
}
