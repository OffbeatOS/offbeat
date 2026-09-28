import { ChangeDetectionStrategy, Component, type OnInit, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import type { LastfmSettingsView, LidarrSettingsView } from '@offbeat/shared';
import { Api, ApiError } from '../../core/api';
import { Icon } from '../../shared/icon/icon';
import { SettingsSection } from './settings-section';

/**
 * Integrations list (settings mockup). Lidarr is required; Last.fm is optional;
 * ListenBrainz needs no setup. The others in the mockup arrive with the phases
 * that use them.
 */
@Component({
  selector: 'ob-integrations-settings',
  imports: [RouterLink, SettingsSection, Icon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: `
    .list {
      display: flex;
      flex-direction: column;
      border-top: 1px solid var(--divider);
    }

    .row {
      display: flex;
      align-items: center;
      gap: 18px;
      padding: 20px 0;
      border-bottom: 1px solid var(--divider);
    }

    .mark {
      width: 44px;
      height: 44px;
      border-radius: var(--radius-input);
      background: var(--surface-2);
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 15px;
      font-weight: 700;
      color: var(--text-label);
      flex-shrink: 0;
    }

    .about {
      flex-grow: 1;
      display: flex;
      flex-direction: column;
      gap: 3px;
      min-width: 0;
    }

    .name {
      font-size: 15px;
      font-weight: 600;
    }

    .desc {
      font-size: 13px;
      color: var(--text-3);
    }

    .connected {
      display: flex;
      align-items: center;
      gap: 6px;
      font-size: 13px;
      font-weight: 500;
      color: var(--text-2);
      margin-right: 8px;
    }

    .configure,
    .connect {
      height: 34px;
      padding: 0 14px;
      border-radius: var(--radius-pill);
      font-size: 13px;
      font-weight: 600;
      display: inline-flex;
      align-items: center;
      color: var(--text-soft);
    }

    .configure {
      background: var(--surface-3);
    }

    .connect {
      border: 1px solid var(--border-button);
    }

    .builtin {
      font-size: 13px;
      font-weight: 500;
      color: var(--text-3);
      white-space: nowrap;
    }

    .desc a {
      color: var(--text-2);
      text-decoration: underline;
    }

    .error {
      font-size: 13px;
      color: var(--status-failed);
    }
  `,
  template: `
    <ob-settings-section
      heading="Integrations"
      description="Lidarr is required. Everything else unlocks extra features."
    >
      <div class="list">
        <div class="row">
          <div class="mark" aria-hidden="true">L</div>
          <div class="about">
            <span class="name">Lidarr</span>
            <span class="desc">Library management, adding artists and albums, download status</span>
            @if (error()) {
              <span class="error">{{ error() }}</span>
            }
          </div>
          @if (lidarr()) {
            <span class="connected"><ob-icon name="check" [size]="14" [strokeWidth]="2.6" />Connected</span>
            <a class="configure" routerLink="lidarr">Configure</a>
          } @else if (loaded()) {
            <a class="connect" routerLink="lidarr">Connect</a>
          }
        </div>
        <div class="row">
          <div class="mark" aria-hidden="true">fm</div>
          <div class="about">
            <span class="name">Last.fm</span>
            <span class="desc">Optional. Preferred source for similar artists and tags when connected</span>
          </div>
          @if (lastfm()?.configured) {
            <span class="connected"><ob-icon name="check" [size]="14" [strokeWidth]="2.6" />Connected</span>
            <a class="configure" routerLink="lastfm">Configure</a>
          } @else if (loaded()) {
            <a class="connect" routerLink="lastfm">Connect</a>
          }
        </div>
        <div class="row">
          <div class="mark" aria-hidden="true">LB</div>
          <div class="about">
            <span class="name">ListenBrainz</span>
            <span class="desc">
              Similar artists for recommendations, no key needed. Add your username in
              <a routerLink="/settings/account">Account</a> to use your listening history.
            </span>
          </div>
          <span class="builtin">Built in</span>
        </div>
      </div>
    </ob-settings-section>
  `,
})
export class IntegrationsSettings implements OnInit {
  private readonly api = inject(Api);
  protected readonly lidarr = signal<LidarrSettingsView | null>(null);
  protected readonly lastfm = signal<LastfmSettingsView | null>(null);
  protected readonly loaded = signal(false);
  protected readonly error = signal('');

  async ngOnInit() {
    try {
      const [{ settings }, lastfm] = await Promise.all([
        this.api.get<{ settings: LidarrSettingsView | null }>('settings/lidarr'),
        this.api.get<LastfmSettingsView>('settings/lastfm'),
      ]);
      this.lidarr.set(settings);
      this.lastfm.set(lastfm);
    } catch (error) {
      this.error.set(error instanceof ApiError ? error.message : 'Could not load integrations');
    } finally {
      this.loaded.set(true);
    }
  }
}
