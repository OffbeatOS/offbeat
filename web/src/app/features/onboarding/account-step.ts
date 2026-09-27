import { ChangeDetectionStrategy, Component, inject, output, signal } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, type ValidationErrors, Validators } from '@angular/forms';
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH, USERNAME_PATTERN } from '@offbeat/shared';
import { ApiError } from '../../core/api';
import { Session } from '../../core/session';
import { FormField } from '../../shared/form-field/form-field';
import { stepStyles } from './step-styles';

/** Step 1: create the admin account, which also signs you in. */
@Component({
  selector: 'ob-account-step',
  imports: [ReactiveFormsModule, FormField],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: [stepStyles],
  template: `
    <div class="intro">
      <h1>Create your account</h1>
      <p>
        This is the admin account for Offbeat. You can invite other people later from Settings.
      </p>
    </div>

    <form [formGroup]="form" (ngSubmit)="submit()" novalidate>
      <div class="fields">
        <ob-field label="Username" hint="Letters, numbers, dots, dashes, or underscores" [error]="usernameError()">
          <input
            class="input"
            formControlName="username"
            autocomplete="username"
            autocapitalize="none"
            spellcheck="false"
            [attr.aria-invalid]="!!usernameError()"
          />
        </ob-field>
        <ob-field label="Password" [hint]="'At least ' + minLength + ' characters'" [error]="passwordError()">
          <input
            class="input"
            type="password"
            formControlName="password"
            autocomplete="new-password"
            [attr.aria-invalid]="!!passwordError()"
          />
        </ob-field>
        <ob-field label="Confirm password" [error]="confirmError()">
          <input
            class="input"
            type="password"
            formControlName="confirm"
            autocomplete="new-password"
            [attr.aria-invalid]="!!confirmError()"
          />
        </ob-field>
      </div>

      <div class="actions">
        <p class="form-error" role="alert">{{ serverError() }}</p>
        <button class="btn btn-primary" type="submit" [disabled]="busy()">
          {{ busy() ? 'Creating account' : 'Continue' }}
        </button>
      </div>
    </form>
  `,
})
export class AccountStep {
  private readonly session = inject(Session);
  readonly done = output();

  protected readonly minLength = PASSWORD_MIN_LENGTH;
  protected readonly busy = signal(false);
  protected readonly serverError = signal('');
  private readonly submitted = signal(false);

  protected readonly form = inject(FormBuilder).nonNullable.group(
    {
      username: ['', [Validators.required, Validators.pattern(USERNAME_PATTERN)]],
      password: [
        '',
        [
          Validators.required,
          Validators.minLength(PASSWORD_MIN_LENGTH),
          Validators.maxLength(PASSWORD_MAX_LENGTH),
        ],
      ],
      confirm: ['', Validators.required],
    },
    {
      validators: (group): ValidationErrors | null =>
        group.get('password')?.value === group.get('confirm')?.value ? null : { mismatch: true },
    },
  );

  protected usernameError() {
    const control = this.form.controls.username;
    if (!this.show(control)) return null;
    if (control.hasError('required')) return 'Choose a username';
    if (control.hasError('pattern')) return 'Use 3 to 32 letters, numbers, dots, dashes, or underscores';
    return null;
  }

  protected passwordError() {
    const control = this.form.controls.password;
    if (!this.show(control)) return null;
    if (control.hasError('required')) return 'Choose a password';
    if (control.hasError('minlength')) return `Use at least ${PASSWORD_MIN_LENGTH} characters`;
    if (control.hasError('maxlength')) return 'That password is too long';
    return null;
  }

  protected confirmError() {
    const control = this.form.controls.confirm;
    if (!this.show(control)) return null;
    if (control.hasError('required')) return 'Type the password again';
    if (this.form.hasError('mismatch')) return 'Passwords do not match';
    return null;
  }

  protected async submit() {
    this.submitted.set(true);
    this.form.markAllAsTouched();
    this.serverError.set('');
    if (this.form.invalid) return;

    this.busy.set(true);
    try {
      const { username, password } = this.form.getRawValue();
      await this.session.createAdmin({ username, password });
      this.done.emit();
    } catch (error) {
      this.serverError.set(error instanceof ApiError ? error.message : 'Something went wrong');
    } finally {
      this.busy.set(false);
    }
  }

  private show(control: { touched: boolean; invalid: boolean }) {
    return (this.submitted() || control.touched) && (control.invalid || this.form.hasError('mismatch'));
  }
}
