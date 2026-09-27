import { ChangeDetectionStrategy, Component, input } from '@angular/core';

/** Section heading and description (settings mockup), then the section body. */
@Component({
  selector: 'ob-settings-section',
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: `
    :host {
      display: flex;
      flex-direction: column;
      gap: 28px;
    }

    header {
      display: flex;
      flex-direction: column;
      gap: 6px;
    }

    h2 {
      font-size: 22px;
      font-weight: 600;
      letter-spacing: -0.01em;
    }

    p {
      font-size: 14px;
      color: var(--text-3);
    }
  `,
  template: `
    <header>
      <h2>{{ heading() }}</h2>
      @if (description()) {
        <p>{{ description() }}</p>
      }
    </header>
    <ng-content />
  `,
})
export class SettingsSection {
  readonly heading = input.required<string>();
  readonly description = input<string>();
}
