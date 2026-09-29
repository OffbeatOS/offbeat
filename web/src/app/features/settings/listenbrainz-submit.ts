import { NgTemplateOutlet } from '@angular/common';
import { ChangeDetectionStrategy, Component, inject, input, output, signal } from '@angular/core';
import type { AccountView, ListenBrainzTokenRequest } from '@offbeat/shared';
import { Api, ApiError } from '../../core/api';
import { timeAgo } from '../../shared/format';

/**
 * Settings, Account, Plays: what you play in Offbeat already shapes your
 * recommendations; with a ListenBrainz user token it is sent there too. The
 * token is checked with ListenBrainz when saved and never shown again.
 */
@Component({
  selector: 'ob-listenbrainz-submit',
  imports: [NgTemplateOutlet],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: `
    :host {
      display: flex;
      flex-direction: column;
      gap: 16px;
      max-width: 560px;
    }

    .field {
      display: flex;
      flex-direction: column;
      gap: 6px;
      font-size: 13px;
      font-weight: 600;
      color: var(--text-label);
    }

    .row {
      display: flex;
      gap: 8px;

      .input {
        flex-grow: 1;
        min-width: 0;
      }

      .btn {
        flex-shrink: 0;
        height: 42px;
      }
    }

    .hint {
      font-size: 12px;
      font-weight: 400;
      color: var(--text-3);
      line-height: 1.45;

      a {
        color: var(--text-2);
        text-decoration: underline;
      }
    }

    .status {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 14px 16px;
      border-radius: 10px;
      background: var(--surface);
      border: 1px solid var(--border-sidebar);
    }

    .dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      flex-shrink: 0;
      background: var(--status-progress);

      &.failed {
        background: var(--status-failed);
      }
    }

    .text {
      flex-grow: 1;
      min-width: 0;
      display: flex;
      flex-direction: column;
      gap: 2px;
    }

    .what {
      font-size: 14px;
      font-weight: 500;
    }

    .when {
      font-size: 13px;
      color: var(--text-3);
    }

    .problem {
      font-size: 13px;
      color: var(--status-failed);
    }

    .remove {
      padding: 0;
      border: 0;
      background: transparent;
      color: var(--status-failed);
      font-size: 13px;
      font-weight: 600;
    }

    .error {
      font-size: 13px;
      color: var(--status-failed);
    }
  `,
  template: `
    @if (account().listenbrainzSubmit; as s) {
      <div class="status" role="status">
        <span class="dot" [class.failed]="!!s.error" aria-hidden="true"></span>
        <span class="text">
          <span class="what">Sending your plays to ListenBrainz as {{ s.userName }}</span>
          @if (s.error) {
            <span class="problem">{{ s.pending }} waiting: {{ s.error }}</span>
          } @else {
            <span class="when">{{ s.lastSubmittedAt ? 'Last sent ' + ago(s.lastSubmittedAt) : 'Plays go there as you listen' }}</span>
          }
        </span>
        <button class="remove" type="button" [disabled]="busy()" (click)="remove()">Remove</button>
      </div>
      @if (s.error?.includes('token')) {
        <p class="hint">Copy your token again from ListenBrainz and add it below to start sending again.</p>
        <ng-container [ngTemplateOutlet]="tokenField" />
      }
    } @else {
      <ng-container [ngTemplateOutlet]="tokenField" />
    }

    <ng-template #tokenField>
      <label class="field">
        ListenBrainz user token
        <span class="row">
          <input
            class="input"
            type="password"
            autocomplete="off"
            spellcheck="false"
            [value]="token()"
            (input)="token.set($any($event.target).value)"
          />
          <button class="btn btn-primary" type="button" [disabled]="busy() || !token().trim()" (click)="connect()">
            {{ busy() ? 'Checking' : 'Send Plays' }}
          </button>
        </span>
        <span class="hint">
          Optional. Find it in your
          <a href="https://listenbrainz.org/settings/" target="_blank" rel="noopener noreferrer">ListenBrainz settings</a>, under User
          token. Plays from now on are sent; earlier ones stay in Offbeat.
        </span>
      </label>
    </ng-template>

    @if (error()) {
      <p class="error" role="alert">{{ error() }}</p>
    }
  `,
})
export class ListenBrainzSubmit {
  private readonly api = inject(Api);

  readonly account = input.required<AccountView>();
  readonly changed = output<AccountView>();

  protected readonly token = signal('');
  protected readonly busy = signal(false);
  protected readonly error = signal('');

  protected ago(iso: string): string {
    return timeAgo(iso);
  }

  protected connect() {
    const body: ListenBrainzTokenRequest = { token: this.token().trim() };
    return this.run(async () => {
      this.changed.emit(await this.api.put<AccountView>('account/listenbrainz-token', body));
      this.token.set('');
    });
  }

  protected remove() {
    return this.run(async () => this.changed.emit(await this.api.delete<AccountView>('account/listenbrainz-token')));
  }

  private async run(action: () => Promise<void>) {
    this.busy.set(true);
    this.error.set('');
    try {
      await action();
    } catch (error) {
      this.error.set(error instanceof ApiError ? error.message : 'Could not reach Offbeat. Try again.');
    } finally {
      this.busy.set(false);
    }
  }
}
