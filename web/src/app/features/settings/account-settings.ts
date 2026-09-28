import { ChangeDetectionStrategy, Component, type OnInit, inject, signal } from '@angular/core';
import { FormBuilder, ReactiveFormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import type { AccountView, UpdateListeningRequest } from '@offbeat/shared';
import { Api, ApiError } from '../../core/api';
import { Session } from '../../core/session';
import { FormField } from '../../shared/form-field/form-field';
import { Icon } from '../../shared/icon/icon';
import { SettingsSection } from './settings-section';

@Component({
  selector: 'ob-account-settings',
  imports: [ReactiveFormsModule, RouterLink, FormField, Icon, SettingsSection],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: `
    :host {
      display: flex;
      flex-direction: column;
      gap: 56px;
    }

    .row {
      display: flex;
      align-items: center;
      gap: 18px;
      padding: 20px 0;
      border-top: 1px solid var(--divider);
      border-bottom: 1px solid var(--divider);
    }

    .avatar {
      width: 44px;
      height: 44px;
      border-radius: 50%;
      background: var(--surface-2);
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 15px;
      font-weight: 700;
      color: var(--text-label);
      text-transform: uppercase;
    }

    .who {
      flex-grow: 1;
      display: flex;
      flex-direction: column;
      gap: 3px;
    }

    .name {
      font-size: 15px;
      font-weight: 600;
    }

    .role {
      font-size: 13px;
      color: var(--text-3);
    }

    form {
      display: flex;
      flex-direction: column;
      gap: 20px;
      max-width: 560px;
    }

    .note {
      margin-top: -12px;
      font-size: 12px;
      line-height: 1.5;
      color: var(--text-3);

      a {
        color: var(--text-2);
        text-decoration: underline;
      }
    }

    .actions {
      display: flex;
      align-items: center;
      gap: 14px;
      flex-wrap: wrap;
    }

    .saved {
      display: flex;
      align-items: center;
      gap: 6px;
      font-size: 13px;
      font-weight: 500;
      color: var(--text-2);
    }

    .error {
      font-size: 13px;
      line-height: 1.4;
      color: var(--status-failed);
    }
  `,
  template: `
    <ob-settings-section heading="Account">
      @if (session.user(); as user) {
        <div class="row">
          <div class="avatar" aria-hidden="true">{{ user.username.charAt(0) }}</div>
          <div class="who">
            <span class="name">{{ user.username }}</span>
            <span class="role">{{ user.role === 'admin' ? 'Admin' : 'Member' }}</span>
          </div>
          <button class="btn btn-outline btn-sm" type="button" [disabled]="busy()" (click)="signOut()">
            Sign out
          </button>
        </div>
      }
    </ob-settings-section>

    <ob-settings-section
      heading="Listening history"
      description="Optional. Recommendations lean toward the artists you actually play. Each name is checked with its service when you save."
    >
      @if (account(); as a) {
        <form [formGroup]="form" (ngSubmit)="save()" novalidate>
          <ob-field
            label="ListenBrainz username"
            hint="Your public listening history on listenbrainz.org. No key needed."
          >
            <input class="input" formControlName="listenbrainzUsername" autocomplete="off" spellcheck="false" />
          </ob-field>
          <ob-field
            label="Last.fm username"
            [hint]="a.lastfmAvailable ? 'Your scrobbles on last.fm.' : ''"
          >
            <input class="input" formControlName="lastfmUsername" autocomplete="off" spellcheck="false" />
          </ob-field>
          @if (!a.lastfmAvailable) {
            <p class="note">
              @if (a.role === 'admin') {
                Connect Last.fm in <a routerLink="/settings/integrations/lastfm">Integrations</a> to use a Last.fm
                username.
              } @else {
                An admin needs to connect Last.fm before a Last.fm username can be used.
              }
            </p>
          }
          @if (error()) {
            <p class="error" role="alert">{{ error() }}</p>
          }
          <div class="actions">
            <button class="btn btn-primary" type="submit" [disabled]="saving() || form.pristine">
              {{ saving() ? 'Checking' : 'Save' }}
            </button>
            @if (saved()) {
              <span class="saved" role="status"><ob-icon name="check" [size]="14" [strokeWidth]="2.6" />Saved</span>
            }
          </div>
        </form>
      } @else if (error()) {
        <p class="error" role="alert">{{ error() }}</p>
      }
    </ob-settings-section>
  `,
})
export class AccountSettings implements OnInit {
  protected readonly session = inject(Session);
  private readonly router = inject(Router);
  private readonly api = inject(Api);

  protected readonly busy = signal(false);
  protected readonly account = signal<AccountView | null>(null);
  protected readonly saving = signal(false);
  protected readonly saved = signal(false);
  protected readonly error = signal('');
  protected readonly form = inject(FormBuilder).nonNullable.group({
    listenbrainzUsername: [''],
    lastfmUsername: [''],
  });

  async ngOnInit() {
    try {
      this.show(await this.api.get<AccountView>('account'));
    } catch (error) {
      this.error.set(error instanceof ApiError ? error.message : 'Could not load your account');
    }
  }

  protected async save() {
    const value = this.form.getRawValue();
    const { controls } = this.form;
    const body: UpdateListeningRequest = {
      ...(controls.listenbrainzUsername.dirty ? { listenbrainzUsername: value.listenbrainzUsername.trim() || null } : {}),
      ...(controls.lastfmUsername.dirty ? { lastfmUsername: value.lastfmUsername.trim() || null } : {}),
    };
    this.saving.set(true);
    this.saved.set(false);
    this.error.set('');
    try {
      this.show(await this.api.put<AccountView>('account/listening', body));
      this.saved.set(true);
    } catch (error) {
      this.error.set(error instanceof ApiError ? error.message : 'Could not save');
    } finally {
      this.saving.set(false);
    }
  }

  protected async signOut() {
    this.busy.set(true);
    try {
      await this.session.logout();
      await this.router.navigateByUrl('/login');
    } finally {
      this.busy.set(false);
    }
  }

  private show(account: AccountView) {
    this.account.set(account);
    this.form.reset({
      listenbrainzUsername: account.listenbrainzUsername ?? '',
      lastfmUsername: account.lastfmUsername ?? '',
    });
    if (account.lastfmAvailable) this.form.controls.lastfmUsername.enable();
    else this.form.controls.lastfmUsername.disable();
  }
}
