import { ChangeDetectionStrategy, Component, inject, input, output, signal } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from '@offbeat/shared';
import { ApiError } from '../../core/api';
import { Session } from '../../core/session';
import { FormField } from '../../shared/form-field/form-field';

/** Current, new, and confirm: used by the first sign-in page and by Settings, Account. */
@Component({
  selector: 'ob-change-password-form',
  imports: [ReactiveFormsModule, FormField],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: `
    form {
      display: flex;
      flex-direction: column;
      gap: 24px;
    }

    .fields {
      display: flex;
      flex-direction: column;
      gap: 20px;
    }

    .actions {
      display: flex;
      align-items: center;
      gap: 16px;
      flex-wrap: wrap;
    }

    .done {
      font-size: 13px;
      color: var(--text-2);
    }
  `,
  template: `
    <form [formGroup]="form" (ngSubmit)="submit()" novalidate>
      <div class="fields">
        <ob-field [label]="currentLabel()">
          <input class="input" type="password" formControlName="currentPassword" autocomplete="current-password" />
        </ob-field>
        <ob-field label="New password" [hint]="'At least ' + min + ' characters'">
          <input class="input" type="password" formControlName="newPassword" autocomplete="new-password" />
        </ob-field>
        <ob-field label="Confirm new password">
          <input class="input" type="password" formControlName="confirm" autocomplete="new-password" />
        </ob-field>
      </div>
      <div class="actions">
        <button class="btn btn-primary" type="submit" [disabled]="busy()">{{ busy() ? 'Saving' : submitLabel() }}</button>
        @if (error()) {
          <p class="form-error" role="alert">{{ error() }}</p>
        } @else if (saved()) {
          <p class="done" role="status">Password changed. Other devices were signed out.</p>
        }
      </div>
    </form>
  `,
})
export class ChangePasswordForm {
  private readonly session = inject(Session);

  readonly currentLabel = input('Current password');
  readonly submitLabel = input('Change Password');
  readonly done = output<void>();

  protected readonly min = PASSWORD_MIN_LENGTH;
  protected readonly busy = signal(false);
  protected readonly error = signal('');
  protected readonly saved = signal(false);
  protected readonly form = inject(FormBuilder).nonNullable.group({
    currentPassword: ['', Validators.required],
    newPassword: ['', [Validators.required, Validators.minLength(PASSWORD_MIN_LENGTH), Validators.maxLength(PASSWORD_MAX_LENGTH)]],
    confirm: ['', Validators.required],
  });

  protected async submit() {
    this.error.set('');
    this.saved.set(false);
    const { currentPassword, newPassword, confirm } = this.form.getRawValue();
    if (!currentPassword) return this.error.set(`Enter your ${this.currentLabel().toLowerCase()}`);
    if (newPassword.length < PASSWORD_MIN_LENGTH) return this.error.set(`Use at least ${PASSWORD_MIN_LENGTH} characters`);
    if (newPassword !== confirm) return this.error.set('The new passwords do not match');
    this.busy.set(true);
    try {
      await this.session.changePassword({ currentPassword, newPassword });
      this.form.reset();
      this.saved.set(true);
      this.done.emit();
    } catch (error) {
      this.error.set(error instanceof ApiError ? error.message : 'Could not change the password');
    } finally {
      this.busy.set(false);
    }
  }
}
