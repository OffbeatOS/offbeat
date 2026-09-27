import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { ApiError } from '../../core/api';
import { safeReturnUrl } from '../../core/guards';
import { Session } from '../../core/session';
import { FocusLayout } from '../../shared/focus-layout/focus-layout';
import { FormField } from '../../shared/form-field/form-field';
import { stepStyles } from '../onboarding/step-styles';

@Component({
  selector: 'ob-login-page',
  imports: [ReactiveFormsModule, FocusLayout, FormField],
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
    `,
  ],
  template: `
    <ob-focus-layout>
      <section>
        <div class="intro">
          <h1>Sign in</h1>
          @if (session.unreachable()) {
            <p>Offbeat's server is not responding. Check that it is running, then try again.</p>
          }
        </div>

        <form [formGroup]="form" (ngSubmit)="submit()" novalidate>
          <div class="fields">
            <ob-field label="Username">
              <input
                class="input"
                formControlName="username"
                autocomplete="username"
                autocapitalize="none"
                spellcheck="false"
                [attr.aria-invalid]="!!error()"
              />
            </ob-field>
            <ob-field label="Password">
              <input
                class="input"
                type="password"
                formControlName="password"
                autocomplete="current-password"
                [attr.aria-invalid]="!!error()"
              />
            </ob-field>
          </div>

          <div class="actions">
            <p class="form-error" role="alert">{{ error() }}</p>
            <button class="btn btn-primary" type="submit" [disabled]="busy()">
              {{ busy() ? 'Signing in' : 'Sign in' }}
            </button>
          </div>
        </form>
      </section>
    </ob-focus-layout>
  `,
})
export class LoginPage {
  protected readonly session = inject(Session);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);

  protected readonly busy = signal(false);
  protected readonly error = signal('');
  protected readonly form = inject(FormBuilder).nonNullable.group({
    username: ['', Validators.required],
    password: ['', Validators.required],
  });

  protected async submit() {
    this.error.set('');
    if (this.form.invalid) {
      this.error.set('Enter your username and password');
      return;
    }
    this.busy.set(true);
    try {
      await this.session.login(this.form.getRawValue());
      const returnUrl = safeReturnUrl(this.route.snapshot.queryParamMap.get('returnUrl'));
      await this.router.navigateByUrl(returnUrl);
    } catch (error) {
      this.error.set(error instanceof ApiError ? error.message : 'Something went wrong');
      this.form.controls.password.reset();
    } finally {
      this.busy.set(false);
    }
  }
}
