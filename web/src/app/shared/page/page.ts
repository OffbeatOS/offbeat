import { ChangeDetectionStrategy, Component, input } from '@angular/core';

/**
 * Standard page frame: title row (with an optional trailing slot for
 * controls like the discovery mode switch) followed by sections spaced 44px apart.
 */
@Component({
  selector: 'ob-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: `
    @use '../mixins';

    :host {
      display: flex;
      flex-direction: column;
      gap: var(--section-gap);
      padding: var(--page-pad-top) var(--page-pad-x) 48px;
    }

    header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      min-height: 40px;
    }

    h1 {
      @include mixins.text-page-title;
    }

    @include mixins.mobile {
      :host {
        gap: 30px;
        padding: 60px 20px 32px;
      }

      header {
        flex-direction: column;
        align-items: stretch;
      }

      h1 {
        font-size: 32px;
      }
    }
  `,
  template: `
    <header>
      <h1>{{ heading() }}</h1>
      <ng-content select="[pageActions]" />
    </header>
    <ng-content />
  `,
})
export class Page {
  readonly heading = input.required<string>();
}
