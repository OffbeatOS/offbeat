import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { Router } from '@angular/router';
import { Session } from '../../core/session';
import { FocusLayout } from '../../shared/focus-layout/focus-layout';
import { stepStyles } from '../onboarding/step-styles';
import { ChangePasswordForm } from './change-password-form';

/**
 * After signing in with a temporary password from an admin: nothing else
 * works until the user chooses their own (the server enforces it too).
 */
@Component({
  selector: 'ob-change-password-page',
  imports: [FocusLayout, ChangePasswordForm],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: [
    stepStyles,
    `
      section {
        display: flex;
        flex-direction: column;
        gap: 40px;
        max-width: 400px;
      }

      .signout {
        align-self: flex-start;
        border: 0;
        background: none;
        padding: 0;
        font-size: 13px;
        color: var(--text-3);
        text-decoration: underline;
      }
    `,
  ],
  template: `
    <ob-focus-layout>
      <section>
        <div class="intro">
          <h1>Choose your password</h1>
          <p>
            Welcome, {{ session.user()?.username }}. You signed in with a temporary password from an admin. Choose your own to
            continue.
          </p>
        </div>
        <ob-change-password-form currentLabel="Temporary password" submitLabel="Continue" (done)="continue()" />
        <button class="signout" type="button" (click)="signOut()">Sign out instead</button>
      </section>
    </ob-focus-layout>
  `,
})
export class ChangePasswordPage {
  protected readonly session = inject(Session);
  private readonly router = inject(Router);

  protected continue() {
    void this.router.navigateByUrl('/discover');
  }

  protected async signOut() {
    await this.session.logout();
    await this.router.navigateByUrl('/login');
  }
}
