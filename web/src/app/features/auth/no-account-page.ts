import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { Session } from '../../core/session';
import { FocusLayout } from '../../shared/focus-layout/focus-layout';
import { stepStyles } from '../onboarding/step-styles';

/**
 * Signed in at the reverse proxy as someone Offbeat does not know, with
 * automatic accounts turned off. Nothing to do here but ask an admin.
 */
@Component({
  selector: 'ob-no-account-page',
  imports: [FocusLayout],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: [
    stepStyles,
    `
      section {
        display: flex;
        flex-direction: column;
        gap: 24px;
        max-width: 440px;
      }
    `,
  ],
  template: `
    <ob-focus-layout>
      <section>
        <div class="intro">
          <h1>No Offbeat account</h1>
          <p>
            You are signed in as <strong>{{ session.unknownProxyUser() }}</strong>, but this Offbeat server has no account for
            that user. Ask an admin to add you in Settings, Users.
          </p>
        </div>
      </section>
    </ob-focus-layout>
  `,
})
export class NoAccountPage {
  protected readonly session = inject(Session);
}
