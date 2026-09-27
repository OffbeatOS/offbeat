import { ChangeDetectionStrategy, Component } from '@angular/core';
import { Wordmark } from '../wordmark/wordmark';

/**
 * Full-page frame without the app shell, for onboarding and sign-in
 * (onboarding mockup): wordmark top left, one 560px column.
 */
@Component({
  selector: 'ob-focus-layout',
  imports: [Wordmark],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: `
    @use '../mixins';

    :host {
      display: flex;
      flex-direction: column;
      align-items: center;
      min-height: 100dvh;
    }

    header {
      width: 100%;
      padding: 32px 48px;
      display: flex;
      align-items: baseline;
      justify-content: space-between;
    }

    main {
      width: 560px;
      max-width: 100%;
      display: flex;
      flex-direction: column;
      gap: 40px;
      padding: 40px 0 64px;
    }

    @include mixins.mobile {
      header {
        padding: 24px 20px;
      }

      main {
        padding: 16px 20px 48px;
        gap: 32px;
      }
    }
  `,
  template: `
    <header>
      <ob-wordmark />
      <ng-content select="[headerActions]" />
    </header>
    <main>
      <ng-content />
    </main>
  `,
})
export class FocusLayout {}
