import { ChangeDetectionStrategy, Component, type OnInit, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import type { LastfmSettingsView } from '@offbeat/shared';
import { Api, ApiError } from '../../core/api';
import { Icon } from '../../shared/icon/icon';
import { LastfmForm } from '../lastfm/lastfm-form';
import { SettingsSection } from './settings-section';

/** Connect, replace, or disconnect the Last.fm API key. */
@Component({
  selector: 'ob-lastfm-settings',
  imports: [RouterLink, Icon, LastfmForm, SettingsSection],
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

    .error {
      font-size: 13px;
      color: var(--status-failed);
    }
  `,
  template: `
    <a class="back" routerLink=".."><ob-icon name="chevron-left" [size]="16" />Integrations</a>
    <ob-settings-section
      heading="Last.fm"
      description="Optional. Recommendations work without it through ListenBrainz; with a key, Last.fm becomes the preferred source for similar artists and tags."
    >
      @if (loaded()) {
        <ob-lastfm-form [current]="current()" (saved)="current.set($event)" />
      }
      @if (error()) {
        <p class="error">{{ error() }}</p>
      }
    </ob-settings-section>
  `,
})
export class LastfmSettings implements OnInit {
  private readonly api = inject(Api);
  protected readonly current = signal<LastfmSettingsView | null>(null);
  protected readonly loaded = signal(false);
  protected readonly error = signal('');

  async ngOnInit() {
    try {
      this.current.set(await this.api.get<LastfmSettingsView>('settings/lastfm'));
      this.loaded.set(true);
    } catch (error) {
      this.error.set(error instanceof ApiError ? error.message : 'Could not load Last.fm settings');
    }
  }
}
