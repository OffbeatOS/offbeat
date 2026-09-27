import { ChangeDetectionStrategy, Component, type OnInit, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import type { LidarrSettingsView } from '@offbeat/shared';
import { Api, ApiError } from '../../core/api';
import { Icon } from '../../shared/icon/icon';
import { SettingsSection } from './settings-section';

/**
 * Integrations list (settings mockup). Lidarr is the only integration so far;
 * the others in the mockup arrive with the phases that use them.
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
      </div>
    </ob-settings-section>
  `,
})
export class IntegrationsSettings implements OnInit {
  private readonly api = inject(Api);
  protected readonly lidarr = signal<LidarrSettingsView | null>(null);
  protected readonly loaded = signal(false);
  protected readonly error = signal('');

  async ngOnInit() {
    try {
      const { settings } = await this.api.get<{ settings: LidarrSettingsView | null }>('settings/lidarr');
      this.lidarr.set(settings);
    } catch (error) {
      this.error.set(error instanceof ApiError ? error.message : 'Could not load integrations');
    } finally {
      this.loaded.set(true);
    }
  }
}
