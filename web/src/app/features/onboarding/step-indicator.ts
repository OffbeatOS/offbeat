import { ChangeDetectionStrategy, Component, input } from '@angular/core';

/** "1. Account  2. Lidarr ..." progress bars from the onboarding mockup. */
@Component({
  selector: 'ob-step-indicator',
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: `
    ol {
      margin: 0;
      padding: 0;
      list-style: none;
      display: grid;
      grid-auto-columns: minmax(0, 1fr);
      grid-auto-flow: column;
      gap: 8px;
    }

    li {
      display: flex;
      flex-direction: column;
      gap: 10px;
      font-size: 12px;
      font-weight: 600;
      color: var(--text-4);
    }

    .bar {
      height: 3px;
      border-radius: 2px;
      background: var(--surface-3);
    }

    .done {
      color: var(--text-lead);

      .bar {
        background: var(--text-4);
      }
    }

    .current {
      color: var(--text);

      .bar {
        background: var(--accent);
      }
    }
  `,
  template: `
    <ol aria-label="Setup steps">
      @for (step of steps(); track step; let i = $index) {
        <li
          [class.done]="i < current()"
          [class.current]="i === current()"
          [attr.aria-current]="i === current() ? 'step' : null"
        >
          <span class="bar"></span>
          {{ i + 1 }}. {{ step }}
        </li>
      }
    </ol>
  `,
})
export class StepIndicator {
  readonly steps = input.required<readonly string[]>();
  readonly current = input.required<number>();
}
