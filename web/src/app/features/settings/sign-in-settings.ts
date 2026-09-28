import { ChangeDetectionStrategy, Component, type OnInit, computed, inject, input, signal } from '@angular/core';
import type { SignInSettings, SignInSettingsView, UserSummary } from '@offbeat/shared';
import { Api, ApiError } from '../../core/api';
import { Icon } from '../../shared/icon/icon';

const lines = (text: string) =>
  text
    .split(/[\n,]/)
    .map((l) => l.trim())
    .filter(Boolean);

/**
 * Settings, Users, Sign-in (SettingsUsers mockup): local accounts, reverse
 * proxy header auth, and local network auto-login. The server checks every
 * rule again; this only lays them out.
 */
@Component({
  selector: 'ob-sign-in-settings',
  imports: [Icon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: `
    :host {
      display: flex;
      flex-direction: column;
      gap: 6px;
    }

    h3 {
      font-size: 15px;
      font-weight: 600;
    }

    .desc {
      font-size: 13px;
      color: var(--text-3);
      margin-bottom: 6px;
    }

    .methods {
      border-top: 1px solid var(--divider);
    }

    .method {
      padding: 14px 0;
      border-bottom: 1px solid var(--divider);
      display: flex;
      flex-direction: column;
      gap: 16px;
    }

    .method-head {
      display: flex;
      align-items: center;
      gap: 16px;
    }

    .what {
      flex-grow: 1;
      display: flex;
      flex-direction: column;
      gap: 3px;

      .label {
        font-size: 14px;
        font-weight: 500;
      }

      .sub {
        font-size: 13px;
        color: var(--text-3);
      }
    }

    [role='switch'] {
      width: 44px;
      height: 26px;
      flex-shrink: 0;
      padding: 0;
      border: 0;
      border-radius: 13px;
      background: var(--surface-4);
      position: relative;

      &::after {
        content: '';
        position: absolute;
        top: 3px;
        left: 3px;
        width: 20px;
        height: 20px;
        border-radius: 50%;
        background: #fff;
        transition: left 120ms ease;
      }

      &[aria-checked='true'] {
        background: var(--accent);

        &::after {
          left: 21px;
        }
      }
    }

    .fields {
      display: flex;
      flex-direction: column;
      gap: 14px;
      padding-left: 2px;
      max-width: 520px;
    }

    label.field {
      display: flex;
      flex-direction: column;
      gap: 6px;
      font-size: 13px;
      font-weight: 600;
      color: var(--text-label);
    }

    textarea.input {
      height: auto;
      min-height: 64px;
      padding-top: 10px;
      padding-bottom: 10px;
      resize: vertical;
      font-family: inherit;
    }

    .hint {
      font-size: 12px;
      font-weight: 400;
      color: var(--text-3);
      line-height: 1.4;
    }

    .check {
      display: flex;
      align-items: flex-start;
      gap: 10px;
      font-size: 14px;

      input {
        margin-top: 3px;
        accent-color: var(--accent);
      }
    }

    .secret {
      display: flex;
      flex-direction: column;
      gap: 8px;
      font-size: 13px;
      font-weight: 600;
      color: var(--text-label);
    }

    .tag {
      margin-left: 6px;
      padding: 2px 8px;
      border-radius: 10px;
      background: var(--surface-3);
      color: var(--text-2);
      font-size: 11px;
      font-weight: 600;
    }

    .secret-row {
      display: flex;
      align-items: center;
      gap: 10px;
      flex-wrap: wrap;

      code {
        flex: 1 1 220px;
        min-width: 0;
        overflow-wrap: anywhere;
        padding: 9px 12px;
        border-radius: var(--radius-input);
        background: var(--surface-input);
        border: 1px solid var(--border-input);
        font-size: 13px;
        font-weight: 400;
        color: var(--text);
        user-select: all;
      }

      .btn {
        height: 36px;
      }
    }

    .warning {
      display: flex;
      gap: 10px;
      padding: 12px 14px;
      border-radius: 10px;
      border: 1px solid var(--status-failed-border);
      background: var(--status-failed-bg);
      color: var(--text-2);
      font-size: 13px;
      line-height: 1.45;

      ob-icon {
        color: var(--status-failed);
        flex-shrink: 0;
        margin-top: 1px;
      }
    }

    .actions {
      display: flex;
      flex-direction: column;
      align-items: flex-start;
      gap: 10px;
      margin-top: 12px;
      max-width: 520px;

      .btn {
        height: 36px;
      }
    }

    .saved {
      font-size: 13px;
      color: var(--text-2);
    }

    .error {
      font-size: 13px;
      color: var(--status-failed);
    }
  `,
  template: `
    <h3>Sign-in</h3>
    <p class="desc">How people get into Offbeat. Local accounts always work for admins.</p>
    @if (draft(); as d) {
      <div class="methods">
        <div class="method">
          <div class="method-head">
            <span class="what">
              <span class="label">Local accounts</span>
              <span class="sub">Username and password stored in Offbeat</span>
            </span>
            <button type="button" role="switch" aria-label="Local accounts" [attr.aria-checked]="d.localAccounts" (click)="patch({ localAccounts: !d.localAccounts })"></button>
          </div>
          @if (!d.localAccounts) {
            <p class="hint">Members sign in through your reverse proxy instead. Admins can still use their password.</p>
          }
        </div>

        <div class="method">
          <div class="method-head">
            <span class="what">
              <span class="label">Reverse proxy header</span>
              <span class="sub">Trust the username from {{ d.proxy.header || 'Remote-User' }}, sent by Authelia, Authentik and similar</span>
            </span>
            <button type="button" role="switch" aria-label="Reverse proxy header" [attr.aria-checked]="d.proxy.enabled" (click)="patchProxy({ enabled: !d.proxy.enabled })"></button>
          </div>
          @if (d.proxy.enabled) {
            <div class="fields">
              <label class="field">
                Trusted proxies
                <textarea class="input" rows="2" spellcheck="false" placeholder="172.20.0.5" [value]="d.proxy.trustedProxies.join('\\n')" (input)="patchProxy({ trustedProxies: lines($any($event.target).value) })"></textarea>
                <span class="hint">Addresses or ranges (like 172.20.0.0/24), one per line. The header is ignored from anywhere else. In Docker, where one address can stand for every visitor, Offbeat also needs the shared secret below before it trusts that address.</span>
              </label>
              <label class="field">
                Header
                <input class="input" spellcheck="false" [value]="d.proxy.header" (input)="patchProxy({ header: $any($event.target).value })" />
                <span class="hint">
                  Your proxy must set this header itself on every route to Offbeat, and remove it where it does not sign
                  people in. A route that passes on a header the visitor made up would let anyone sign in as anyone.
                </span>
              </label>
              <div class="field secret">
                <span>Shared secret <span class="tag">Recommended</span></span>
                <span class="hint">
                  Have your proxy also send this header with this value on every request. Then a proxy route that passes on a
                  made-up username still cannot sign anyone in.
                </span>
                <input
                  class="input"
                  spellcheck="false"
                  aria-label="Secret header name"
                  [value]="d.proxy.secretHeader"
                  (input)="patchProxy({ secretHeader: $any($event.target).value })"
                />
                @if (d.proxy.secret) {
                  <div class="secret-row">
                    <code>{{ d.proxy.secret }}</code>
                    <button class="btn btn-outline btn-sm" type="button" (click)="copy(d.proxy.secret)">{{ copied() ? 'Copied' : 'Copy' }}</button>
                  </div>
                  <span class="hint">Put this in your proxy's configuration, then Save. It is not shown again.</span>
                } @else {
                  <div class="secret-row">
                    <span class="hint">{{ view()?.proxySecretSet && d.proxy.secret !== '' ? 'A secret is saved.' : 'No secret yet.' }}</span>
                    <button class="btn btn-outline btn-sm" type="button" (click)="generate()">
                      {{ view()?.proxySecretSet ? 'Replace' : 'Generate' }}
                    </button>
                    @if (view()?.proxySecretSet && d.proxy.secret !== '') {
                      <button class="btn btn-ghost btn-sm" type="button" (click)="patchProxy({ secret: '' })">Remove</button>
                    }
                  </div>
                }
              </div>
              <label class="check">
                <input type="checkbox" [checked]="d.proxy.autoCreate" (change)="patchProxy({ autoCreate: !d.proxy.autoCreate })" />
                <span>
                  Create accounts for new users
                  <span class="hint"><br />As Members who can add albums, never as admins. When off, people without an account are asked to see an admin.</span>
                </span>
              </label>
              <label class="field">
                Sign-out page
                <input class="input" spellcheck="false" placeholder="https://auth.example.com/logout" [value]="d.proxy.logoutUrl ?? ''" (input)="patchProxy({ logoutUrl: $any($event.target).value.trim() || null })" />
                <span class="hint">Your proxy's sign-out address. Without it, signing out of Offbeat signs you straight back in.</span>
              </label>
            </div>
          }
        </div>

        <div class="method">
          <div class="method-head">
            <span class="what">
              <span class="label">Local network auto-login</span>
              <span class="sub">Sign in as a chosen user from trusted addresses without a password</span>
            </span>
            <button type="button" role="switch" aria-label="Local network auto-login" [attr.aria-checked]="d.autoLogin.enabled" (click)="patchAuto({ enabled: !d.autoLogin.enabled })"></button>
          </div>
          @if (d.autoLogin.enabled) {
            <div class="fields">
              <div class="warning" role="note">
                <ob-icon name="alert" [size]="16" [strokeWidth]="2" />
                <span>
                  Anyone who can reach Offbeat from these addresses is signed in as
                  <strong>{{ autoUserName() || 'the chosen Member' }}</strong> without a password. Only use this on a network you
                  trust. It never signs in as an admin.
                </span>
              </div>
              <label class="field">
                Sign in as
                <select class="input" [value]="d.autoLogin.userId ?? ''" (change)="patchAuto({ userId: +$any($event.target).value || null })">
                  <option value="">Choose a Member</option>
                  @for (m of members(); track m.id) {
                    <option [value]="m.id" [selected]="m.id === d.autoLogin.userId">{{ m.username }}</option>
                  }
                </select>
                @if (!members().length) {
                  <span class="hint">Add a Member first. Auto-login never signs in as an admin.</span>
                }
              </label>
              <label class="field">
                Local network
                <textarea class="input" rows="2" spellcheck="false" placeholder="192.168.1.0/24" [value]="d.autoLogin.networks.join('\\n')" (input)="patchAuto({ networks: lines($any($event.target).value) })"></textarea>
                <span class="hint">
                  Addresses or ranges, one per line.
                  @if (view()?.yourAddress; as you) {
                    Offbeat sees you at {{ you }}.
                  }
                  @if (view()?.dockerAddresses?.length) {
                    Offbeat runs in Docker, where {{ view()!.dockerAddresses.join(' and ') }} can stand for anyone, so
                    {{ view()!.dockerAddresses.length === 1 ? 'it never counts' : 'they never count' }} as local.
                  }
                  Behind a reverse proxy, add it under Trusted proxies so Offbeat sees each visitor's real address. Auto-login
                  only answers requests addressed to a local name: an IP address, a name like hoth, a .local, .lan, or .home.arpa
                  name, or the "Link back to Offbeat" address in Notifications.
                </span>
              </label>
            </div>
          }
        </div>
      </div>
      <div class="actions">
        <button class="btn btn-primary btn-sm" type="button" [disabled]="busy() || !dirty()" (click)="save()">{{ busy() ? 'Saving' : 'Save' }}</button>
        @if (error()) {
          <p class="error" role="alert">{{ error() }}</p>
        } @else if (saved()) {
          <p class="saved" role="status">Saved</p>
        }
      </div>
    }
  `,
})
export class SignInSettingsPanel implements OnInit {
  private readonly api = inject(Api);

  /** Everyone, to choose the auto-login Member from. */
  readonly users = input<UserSummary[]>([]);

  protected readonly lines = lines;
  protected readonly view = signal<SignInSettingsView | null>(null);
  protected readonly draft = signal<SignInSettings | null>(null);
  protected readonly busy = signal(false);
  protected readonly error = signal('');
  protected readonly saved = signal(false);
  protected readonly copied = signal(false);
  protected readonly members = computed(() => this.users().filter((u) => u.role === 'user'));
  protected readonly autoUserName = computed(() => this.users().find((u) => u.id === this.draft()?.autoLogin.userId)?.username ?? '');
  protected readonly dirty = computed(() => {
    const view = this.view();
    const draft = this.draft();
    if (!view || !draft) return false;
    const { localAccounts, proxy, autoLogin } = view;
    return JSON.stringify({ localAccounts, proxy, autoLogin }) !== JSON.stringify(draft);
  });

  async ngOnInit() {
    try {
      this.take(await this.api.get<SignInSettingsView>('settings/sign-in'));
    } catch (error) {
      this.error.set(error instanceof ApiError ? error.message : 'Could not load sign-in settings');
    }
  }

  protected patch(change: Partial<SignInSettings>) {
    this.draft.update((d) => (d ? { ...d, ...change } : d));
    this.saved.set(false);
  }

  protected patchProxy(change: Partial<SignInSettings['proxy']>) {
    this.draft.update((d) => (d ? { ...d, proxy: { ...d.proxy, ...change } } : d));
    this.saved.set(false);
  }

  protected patchAuto(change: Partial<SignInSettings['autoLogin']>) {
    this.draft.update((d) => (d ? { ...d, autoLogin: { ...d.autoLogin, ...change } } : d));
    this.saved.set(false);
  }

  /** A strong random secret (32 bytes), shown until saved. */
  protected generate() {
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    const secret = btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    this.copied.set(false);
    this.patchProxy({ secret });
  }

  protected async copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      this.copied.set(true);
    } catch {
      this.error.set('Could not copy. Select the secret and copy it yourself.');
    }
  }

  protected async save() {
    const draft = this.draft();
    if (!draft) return;
    this.busy.set(true);
    this.error.set('');
    try {
      this.take(await this.api.put<SignInSettingsView>('settings/sign-in', draft));
      this.saved.set(true);
    } catch (error) {
      this.error.set(error instanceof ApiError ? error.message : 'Could not save sign-in settings');
    } finally {
      this.busy.set(false);
    }
  }

  private take(view: SignInSettingsView) {
    this.view.set(view);
    const { localAccounts, proxy, autoLogin } = view;
    this.draft.set(structuredClone({ localAccounts, proxy, autoLogin }));
  }
}
