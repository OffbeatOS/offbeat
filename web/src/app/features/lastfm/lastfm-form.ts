import { ChangeDetectionStrategy, Component, inject, input, output, signal } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import type { LastfmSettingsRequest, LastfmSettingsView } from '@offbeat/shared';
import { Api, ApiError } from '../../core/api';
import { FormField } from '../../shared/form-field/form-field';
import { Icon } from '../../shared/icon/icon';

/**
 * Last.fm API key, checked with Last.fm when saved. Used by the setup wizard
 * and by Settings. The saved key never comes back to the browser; only its
 * last four characters do.
 */
@Component({
  selector: 'ob-lastfm-form',
  imports: [ReactiveFormsModule, FormField, Icon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: `
    form {
      display: flex;
      flex-direction: column;
      gap: 20px;
      max-width: 560px;
    }

    .connected {
      display: flex;
      align-items: center;
      gap: 6px;
      font-size: 13px;
      font-weight: 500;
      color: var(--text-2);
    }

    .actions {
      display: flex;
      align-items: center;
      gap: 12px;
      flex-wrap: wrap;
    }

    .hint {
      margin-top: -12px;
      font-size: 12px;
      line-height: 1.5;
      color: var(--text-3);
    }

    .error {
      font-size: 13px;
      line-height: 1.4;
      color: var(--status-failed);
    }

    a {
      color: var(--text-2);
      text-decoration: underline;
    }
  `,
  template: `
    <form [formGroup]="form" (ngSubmit)="save()" novalidate>
      @if (current()?.configured) {
        <span class="connected" role="status">
          <ob-icon name="check" [size]="14" [strokeWidth]="2.6" />Connected, key ending in {{ current()!.keyEnding }}
        </span>
      }
      <ob-field label="API Key">
        <input
          class="input"
          type="password"
          formControlName="apiKey"
          autocomplete="off"
          spellcheck="false"
          [placeholder]="current()?.configured ? 'Paste a new key to replace it' : ''"
        />
      </ob-field>
      <p class="hint">
        Create one free at
        <a href="https://www.last.fm/api/account/create" target="_blank" rel="noopener noreferrer">last.fm/api</a>. Only the
        API key is needed, not the shared secret.
      </p>
      @if (error()) {
        <p class="error" role="alert">{{ error() }}</p>
      }
      <div class="actions">
        <button class="btn btn-primary" type="submit" [disabled]="busy() || form.invalid">
          {{ busy() === 'save' ? 'Checking key' : submitLabel() }}
        </button>
        @if (current()?.configured && allowDisconnect()) {
          <button class="btn btn-ghost" type="button" [disabled]="!!busy()" (click)="disconnect()">
            {{ busy() === 'disconnect' ? 'Disconnecting' : 'Disconnect' }}
          </button>
        }
        <ng-content select="[formAction]" />
      </div>
    </form>
  `,
})
export class LastfmForm {
  private readonly api = inject(Api);

  readonly current = input<LastfmSettingsView | null>(null);
  readonly submitLabel = input('Save');
  readonly allowDisconnect = input(true);
  readonly saved = output<LastfmSettingsView>();

  protected readonly busy = signal<'save' | 'disconnect' | null>(null);
  protected readonly error = signal('');
  protected readonly form = inject(FormBuilder).nonNullable.group({
    apiKey: ['', [Validators.required, Validators.pattern(/^\s*[0-9a-fA-F]{32}\s*$/)]],
  });

  protected async save() {
    if (this.form.invalid) return;
    const body: LastfmSettingsRequest = { apiKey: this.form.getRawValue().apiKey.trim() };
    await this.run('save', async () => {
      const view = await this.api.put<LastfmSettingsView>('settings/lastfm', body);
      this.form.reset();
      this.saved.emit(view);
    });
  }

  protected async disconnect() {
    await this.run('disconnect', async () => this.saved.emit(await this.api.delete<LastfmSettingsView>('settings/lastfm')));
  }

  private async run(kind: 'save' | 'disconnect', action: () => Promise<void>) {
    this.busy.set(kind);
    this.error.set('');
    try {
      await action();
    } catch (error) {
      this.error.set(error instanceof ApiError ? error.message : 'Could not reach Offbeat');
    } finally {
      this.busy.set(null);
    }
  }
}
