import { ChangeDetectionStrategy, Component, type OnInit, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import type { LidarrSettingsView } from '@offbeat/shared';
import { Api, ApiError } from '../../core/api';
import { Session } from '../../core/session';
import { Icon } from '../../shared/icon/icon';
import { LidarrForm } from '../lidarr/lidarr-form';
import { LidarrWebhook } from './lidarr-webhook';
import { MusicFiles } from './music-files';
import { SettingsSection } from './settings-section';

/** Edit the Lidarr connection and defaults after setup. */
@Component({
  selector: 'ob-lidarr-settings',
  imports: [RouterLink, Icon, LidarrForm, SettingsSection, LidarrWebhook, MusicFiles],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: `
    .back {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      margin-bottom: 16px;
      font-size: 13px;
      font-weight: 500;
      color: var(--text-3);

      &:hover {
        color: var(--text);
      }
    }

    .notice {
      font-size: 13px;
      color: var(--text-2);
      display: flex;
      align-items: center;
      gap: 6px;
    }

    .error {
      font-size: 13px;
      color: var(--status-failed);
    }

    .webhook,
    .music {
      margin-top: 24px;
      padding-top: 32px;
      border-top: 1px solid var(--divider);
    }
  `,
  template: `
    <a class="back" routerLink="..">
      <ob-icon name="chevron-left" [size]="16" />Integrations
    </a>
    <ob-settings-section
      heading="Lidarr"
      description="Use the address Offbeat can see from its container, not necessarily the one in your browser."
    >
      @if (loaded()) {
        <ob-lidarr-form [existing]="existing()" [showAddOptions]="true" submitLabel="Save" (saved)="onSaved($event)" />
      }
      @if (error()) {
        <p class="error">{{ error() }}</p>
      }
      @if (savedAt()) {
        <p class="notice" role="status"><ob-icon name="check" [size]="14" [strokeWidth]="2.6" />Saved</p>
      }
      @if (existing()) {
        <ob-lidarr-webhook class="webhook" />
        <ob-music-files class="music" />
      }
    </ob-settings-section>
  `,
})
export class LidarrSettings implements OnInit {
  private readonly api = inject(Api);
  private readonly session = inject(Session);

  protected readonly existing = signal<LidarrSettingsView | null>(null);
  protected readonly loaded = signal(false);
  protected readonly error = signal('');
  protected readonly savedAt = signal<Date | null>(null);

  async ngOnInit() {
    try {
      const { settings } = await this.api.get<{ settings: LidarrSettingsView | null }>('settings/lidarr');
      this.existing.set(settings);
      this.loaded.set(true);
    } catch (error) {
      this.error.set(error instanceof ApiError ? error.message : 'Could not load Lidarr settings');
    }
  }

  protected onSaved(view: LidarrSettingsView) {
    this.existing.set(view);
    this.session.lidarrConfigured.set(true);
    this.savedAt.set(new Date());
  }
}
