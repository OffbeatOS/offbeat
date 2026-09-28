import { ChangeDetectionStrategy, Component, DestroyRef, type OnInit, computed, inject, signal } from '@angular/core';
import type { LidarrWebhookView } from '@offbeat/shared';
import { Api, ApiError } from '../../core/api';
import { timeAgo } from '../../shared/format';

/** While the page is open, refresh the "Last event" line this often. */
const REFRESH_MS = 15_000;

/**
 * Settings, Lidarr, Instant updates (SettingsLidarr mockup): Lidarr calls
 * Offbeat the moment something is grabbed or imported. Set Up Automatically
 * creates (or updates) the webhook in Lidarr after Lidarr proves it can
 * reach the address. The credentials go in Lidarr's Basic auth fields, never
 * in the URL.
 */
@Component({
  selector: 'ob-lidarr-webhook',
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: `
    :host {
      display: flex;
      flex-direction: column;
      gap: 20px;
      max-width: 640px;
    }

    .head {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 16px;

      h3 {
        font-size: 15px;
        font-weight: 600;
      }

      p {
        margin-top: 4px;
        font-size: 13px;
        color: var(--text-3);
        line-height: 1.5;
      }
    }

    label.field,
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

    .mono {
      font-family: ui-monospace, 'SF Mono', Menlo, monospace;
      font-size: 13px;
    }

    .hint {
      font-size: 12px;
      font-weight: 400;
      color: var(--text-3);
      line-height: 1.45;
    }

    .status {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 14px 16px;
      border-radius: 10px;
      background: var(--surface);
      border: 1px solid var(--border-sidebar);

      .dot {
        width: 8px;
        height: 8px;
        border-radius: 50%;
        background: var(--text-4);
        flex-shrink: 0;

        &.on {
          background: var(--status-progress);
        }
      }

      .what {
        font-size: 14px;
        font-weight: 500;
      }

      .when {
        flex-grow: 1;
        font-size: 13px;
        color: var(--text-3);
      }

      .btn {
        height: 30px;
        padding: 0 12px;
        font-size: 12px;
      }
    }

    .manual {
      display: flex;
      flex-direction: column;
      gap: 12px;

      > .title {
        font-size: 13px;
        font-weight: 600;
        color: var(--text-label);
      }
    }

    .links {
      display: flex;
      gap: 18px;

      button {
        height: 28px;
        padding: 0;
        border: 0;
        background: transparent;
        font-size: 13px;
        font-weight: 600;
        color: var(--text-2);

        &.danger {
          color: var(--status-failed);
        }
      }
    }

    .btn-soft {
      background: var(--surface-3);
      color: var(--text-soft);
    }

    .message {
      font-size: 13px;
      color: var(--text-2);
    }

    .error {
      font-size: 13px;
      color: var(--status-failed);
      line-height: 1.45;
    }
  `,
  template: `
    <div class="head">
      <div>
        <h3>Instant updates</h3>
        <p>
          Lets Lidarr tell Offbeat the moment something is grabbed or imported. Without it, Offbeat checks Lidarr on a timer,
          which still works.
        </p>
      </div>
    </div>

    @if (view(); as v) {
      <label class="field">
        Offbeat's address, as Lidarr sees it
        <div class="row">
          <input class="input mono" spellcheck="false" [value]="url()" (input)="url.set($any($event.target).value)" />
          <button class="btn btn-primary btn-sm" type="button" [disabled]="busy()" (click)="setUp()">
            {{ busy() === 'setup' ? 'Testing with Lidarr' : v.installed ? 'Save Address' : 'Set Up Automatically' }}
          </button>
        </div>
        <span class="hint">
          Lidarr calls this address, so it has to reach it from where Lidarr runs. localhost usually will not work: use this
          machine's network address, or the container name when both run in the same Docker network. Offbeat asks Lidarr to
          send a test first and only saves an address that worked.
        </span>
      </label>

      <div class="status" role="status">
        <span class="dot" [class.on]="v.installed && !!v.lastEventAt" aria-hidden="true"></span>
        <span class="what">{{ statusText() }}</span>
        <span class="when">{{ lastEventText() }}</span>
        @if (v.callbackUrl) {
          <button class="btn btn-soft" type="button" [disabled]="busy()" (click)="test()">{{ busy() === 'test' ? 'Testing' : 'Send Test' }}</button>
        }
      </div>

      @if (error()) {
        <p class="error" role="alert">{{ error() }}</p>
      } @else if (message()) {
        <p class="message" role="status">{{ message() }}</p>
      }

      <div class="manual">
        <span class="title">Or set it up in Lidarr yourself</span>
        <span class="hint">
          In Lidarr, open Settings, Connect, and add a Webhook. Use this URL, method POST, and the username and password below
          (they go in the webhook's Username and Password fields, not the URL). Turn on On Grab, On Release Import, On Upgrade, On
          Download Failure and On Import Failure.
        </span>
        <div class="field">
          URL
          <div class="row">
            <input class="input mono" readonly [value]="v.callbackUrl ?? url()" aria-label="Webhook URL" />
            <button class="btn btn-soft btn-sm" type="button" (click)="copy(v.callbackUrl ?? url(), 'URL')">Copy</button>
          </div>
        </div>
        <div class="field">
          Username
          <div class="row">
            <input class="input mono" readonly [value]="v.username" aria-label="Webhook username" />
            <button class="btn btn-soft btn-sm" type="button" (click)="copy(v.username, 'Username')">Copy</button>
          </div>
        </div>
        <div class="field">
          Password
          <div class="row">
            <input class="input mono" readonly [type]="reveal() ? 'text' : 'password'" [value]="v.password" aria-label="Webhook password" />
            <button class="btn btn-soft btn-sm" type="button" (click)="reveal.set(!reveal())">{{ reveal() ? 'Hide' : 'Show' }}</button>
            <button class="btn btn-soft btn-sm" type="button" (click)="copy(v.password, 'Password')">Copy</button>
          </div>
        </div>
        <div class="links">
          <button type="button" [disabled]="busy()" (click)="regenerate()">Regenerate password</button>
          @if (v.installed) {
            <button class="danger" type="button" [disabled]="busy()" (click)="remove()">Remove from Lidarr</button>
          }
        </div>
      </div>
    } @else if (error()) {
      <p class="error" role="alert">{{ error() }}</p>
    }
  `,
})
export class LidarrWebhook implements OnInit {
  private readonly api = inject(Api);

  protected readonly view = signal<LidarrWebhookView | null>(null);
  protected readonly url = signal('');
  protected readonly busy = signal<'setup' | 'test' | 'token' | 'remove' | null>(null);
  protected readonly error = signal('');
  protected readonly message = signal('');
  protected readonly reveal = signal(false);
  private readonly tick = signal(0);

  protected readonly statusText = computed(() => {
    const v = this.view();
    if (!v?.installed) return 'Not set up';
    return v.lastEventAt ? 'Receiving events' : 'Set up, waiting for the first event';
  });
  protected readonly lastEventText = computed(() => {
    this.tick();
    const v = this.view();
    return v?.lastEventAt ? `Last event ${timeAgo(v.lastEventAt)}: ${v.lastEvent}` : '';
  });

  constructor() {
    const timer = setInterval(() => {
      this.tick.update((t) => t + 1);
      void this.load(true);
    }, REFRESH_MS);
    inject(DestroyRef).onDestroy(() => clearInterval(timer));
  }

  async ngOnInit() {
    await this.load(false);
  }

  protected setUp() {
    return this.run('setup', async () => {
      this.take(await this.api.put<LidarrWebhookView>('settings/lidarr/webhook', { callbackUrl: this.url().trim() }));
      this.message.set('Lidarr reached Offbeat, and the webhook is saved in Lidarr.');
    });
  }

  protected test() {
    return this.run('test', async () => {
      this.take(await this.api.post<LidarrWebhookView>('settings/lidarr/webhook/test'));
      this.message.set('Lidarr sent a test, and Offbeat received it.');
    });
  }

  protected regenerate() {
    return this.run('token', async () => {
      this.take(await this.api.post<LidarrWebhookView>('settings/lidarr/webhook/token'));
      this.message.set(this.view()?.installed ? 'New password saved, and Lidarr updated to match.' : 'New password made.');
    });
  }

  protected remove() {
    return this.run('remove', async () => {
      this.take(await this.api.delete<LidarrWebhookView>('settings/lidarr/webhook'));
      this.message.set('Removed from Lidarr. Offbeat keeps checking Lidarr on a timer.');
    });
  }

  protected async copy(text: string, what: string) {
    try {
      await navigator.clipboard.writeText(text);
      this.message.set(`${what} copied.`);
      this.error.set('');
    } catch {
      this.error.set('Could not copy. Select the text and copy it yourself.');
    }
  }

  private async run(kind: 'setup' | 'test' | 'token' | 'remove', action: () => Promise<void>) {
    this.busy.set(kind);
    this.error.set('');
    this.message.set('');
    try {
      await action();
    } catch (error) {
      this.error.set(error instanceof ApiError ? error.message : 'Something went wrong');
    } finally {
      this.busy.set(null);
    }
  }

  private async load(quiet: boolean) {
    try {
      this.take(await this.api.get<LidarrWebhookView>('settings/lidarr/webhook'), quiet);
    } catch (error) {
      if (!quiet) this.error.set(error instanceof ApiError ? error.message : 'Could not load the webhook settings');
    }
  }

  /** New state from the server; the address field keeps what the admin is typing during quiet refreshes. */
  private take(view: LidarrWebhookView, quiet = false) {
    const before = this.view();
    this.view.set(view);
    const typed = before && this.url() !== (before.callbackUrl ?? before.suggestedUrl);
    if (!quiet || !typed) this.url.set(view.callbackUrl ?? view.suggestedUrl);
  }
}
