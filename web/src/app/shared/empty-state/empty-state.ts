import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { Icon, type IconName } from '../icon/icon';

/** Quiet placeholder for screens with nothing to show yet. */
@Component({
  selector: 'ob-empty-state',
  imports: [Icon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: `
    @use '../mixins';

    :host {
      display: flex;
      flex-direction: column;
      align-items: center;
      text-align: center;
      gap: 16px;
      padding: 96px 24px;
    }

    .badge {
      width: 56px;
      height: 56px;
      border-radius: 50%;
      background: var(--surface-3);
      color: var(--text-2);
      display: flex;
      align-items: center;
      justify-content: center;
    }

    .copy {
      display: flex;
      flex-direction: column;
      gap: 6px;
      max-width: 360px;
    }

    h2 {
      @include mixins.text-card-title;
    }

    p {
      @include mixins.text-caption;
      color: var(--text-3);
      line-height: 1.5;
    }
  `,
  template: `
    <div class="badge"><ob-icon [name]="icon()" [size]="24" /></div>
    <div class="copy">
      <h2>{{ heading() }}</h2>
      @if (message()) {
        <p>{{ message() }}</p>
      }
    </div>
    <ng-content />
  `,
})
export class EmptyState {
  readonly icon = input.required<IconName>();
  readonly heading = input.required<string>();
  readonly message = input<string>();
}
