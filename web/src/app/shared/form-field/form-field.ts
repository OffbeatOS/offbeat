import { ChangeDetectionStrategy, Component, input } from '@angular/core';

/**
 * Label, control, and helper or error text (onboarding mockup). Wraps the
 * projected control in the <label> so they are associated without ids.
 */
@Component({
  selector: 'ob-field',
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: `
    label {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }

    .label {
      font-size: 13px;
      font-weight: 600;
      color: var(--text-label);
    }

    .hint,
    .error {
      font-size: 12px;
      color: var(--text-3);
    }

    .error {
      color: var(--status-failed);
    }
  `,
  template: `
    <!-- The control is projected inside the label, which associates them. -->
    <!-- eslint-disable-next-line @angular-eslint/template/label-has-associated-control -->
    <label>
      <span class="label">{{ label() }}</span>
      <ng-content />
      @if (error()) {
        <span class="error">{{ error() }}</span>
      } @else if (hint()) {
        <span class="hint">{{ hint() }}</span>
      }
    </label>
  `,
})
export class FormField {
  readonly label = input.required<string>();
  readonly hint = input<string>();
  readonly error = input<string | null>();
}
