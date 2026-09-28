import { ChangeDetectionStrategy, Component, type OnInit, computed, inject, signal } from '@angular/core';
import {
  type ChannelKind,
  type Delivery,
  NOTIFICATION_EVENTS,
  type NotificationEvent,
  type NotificationSettingsView,
} from '@offbeat/shared';
import { Api, ApiError } from '../../core/api';
import { timeAgo } from '../../shared/format';

const EVENT_LABEL: Record<NotificationEvent, string> = {
  'album-imported': 'An album is imported',
  'download-failed': 'A download fails',
  'import-blocked': 'An import is blocked',
  'new-release': 'A monitored artist has a new release',
};

const CHANNELS: { kind: ChannelKind; name: string; mark: string; blurb: string }[] = [
  { kind: 'discord', name: 'Discord', mark: 'D', blurb: 'Post to a Discord channel' },
  { kind: 'webhook', name: 'Webhook', mark: '{ }', blurb: 'Send JSON to any URL' },
];

interface Draft {
  enabled: boolean;
  url: string;
  secret: string | null;
  events: NotificationEvent[];
}

/**
 * Settings, Notifications (SettingsNotifications mockup, with Discord and a
 * generic webhook as the channels): where alerts about downloads and
 * releases go, and a log of what was sent.
 */
@Component({
  selector: 'ob-notifications-settings',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './notifications-settings.html',
  styleUrl: './notifications-settings.scss',
})
export class NotificationsSettings implements OnInit {
  private readonly api = inject(Api);

  protected readonly channels = CHANNELS;
  protected readonly events = NOTIFICATION_EVENTS;
  protected readonly eventLabel = EVENT_LABEL;
  protected readonly view = signal<NotificationSettingsView | null>(null);
  protected readonly selected = signal<ChannelKind | null>(null);
  protected readonly draft = signal<Draft | null>(null);
  protected readonly publicUrl = signal('');
  protected readonly busy = signal<'save' | 'test' | 'remove' | 'link' | null>(null);
  protected readonly error = signal('');
  protected readonly note = signal('');
  protected readonly selectedInfo = computed(() => CHANNELS.find((c) => c.kind === this.selected()) ?? null);

  async ngOnInit() {
    try {
      this.take(await this.api.get<NotificationSettingsView>('settings/notifications'));
    } catch (error) {
      this.error.set(error instanceof ApiError ? error.message : 'Could not load notifications');
    }
  }

  protected summary(kind: ChannelKind): string {
    const v = this.view();
    const saved = v?.[kind];
    if (!saved) return CHANNELS.find((c) => c.kind === kind)!.blurb;
    const where = kind === 'discord' ? v!.discord!.urlHint : v!.webhook!.url.replace(/^https?:\/\//, '');
    return `${where}, ${saved.events.length} ${saved.events.length === 1 ? 'event' : 'events'}`;
  }

  protected select(kind: ChannelKind) {
    const saved = this.view()?.[kind];
    this.selected.set(kind);
    this.error.set('');
    this.note.set('');
    this.draft.set({
      enabled: saved?.enabled ?? true,
      url: kind === 'webhook' ? (this.view()?.webhook?.url ?? '') : '',
      secret: null,
      events: saved ? [...saved.events] : [...NOTIFICATION_EVENTS],
    });
  }

  protected patch(change: Partial<Draft>) {
    this.draft.update((d) => (d ? { ...d, ...change } : d));
  }

  protected toggleEvent(event: NotificationEvent) {
    const d = this.draft();
    if (!d) return;
    const events = d.events.includes(event) ? d.events.filter((e) => e !== event) : [...d.events, event];
    this.patch({ events: NOTIFICATION_EVENTS.filter((e) => events.includes(e)) });
  }

  protected generateSecret() {
    const bytes = crypto.getRandomValues(new Uint8Array(24));
    this.patch({ secret: btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') });
  }

  protected async save() {
    const kind = this.selected();
    const d = this.draft();
    if (!kind || !d) return;
    await this.run('save', async () => {
      const body =
        kind === 'discord'
          ? { enabled: d.enabled, url: d.url.trim() || null, events: d.events }
          : { enabled: d.enabled, url: d.url.trim(), secret: d.secret, events: d.events };
      this.take(await this.api.put<NotificationSettingsView>(`settings/notifications/${kind}`, body));
      this.patch({ url: kind === 'webhook' ? d.url.trim() : '', secret: null });
      this.note.set('Saved');
    });
  }

  protected async test() {
    const kind = this.selected();
    if (!kind) return;
    await this.run('test', async () => this.take(await this.api.post<NotificationSettingsView>(`settings/notifications/${kind}/test`)));
  }

  protected async remove() {
    const kind = this.selected();
    if (!kind) return;
    await this.run('remove', async () => {
      this.take(await this.api.delete<NotificationSettingsView>(`settings/notifications/${kind}`));
      this.selected.set(null);
    });
  }

  protected async saveLink() {
    await this.run('link', async () => {
      this.take(await this.api.put<NotificationSettingsView>('settings/notifications', { publicUrl: this.publicUrl().trim() || null }));
      this.note.set('');
    });
  }

  protected testLine(kind: ChannelKind): string {
    const test = this.view()?.[kind]?.lastTest;
    if (!test) return '';
    return test.ok ? `Test delivered ${timeAgo(test.at)}` : `Test failed ${timeAgo(test.at)}: ${test.error}`;
  }

  protected deliveryStatus(d: Delivery): string {
    if (d.status === 'delivered') return 'Delivered';
    if (d.status === 'retrying') return 'Failed, retrying';
    return 'Failed';
  }

  protected deliveryLine(d: Delivery): string {
    const to = d.channel === 'discord' ? 'Discord' : 'the webhook';
    const why = d.status !== 'delivered' && d.error ? ` (${d.error})` : '';
    return `${d.message}, to ${to}${why}`;
  }

  protected ago(iso: string) {
    return timeAgo(iso);
  }

  private async run(kind: 'save' | 'test' | 'remove' | 'link', action: () => Promise<void>) {
    this.busy.set(kind);
    this.error.set('');
    this.note.set('');
    try {
      await action();
    } catch (error) {
      this.error.set(error instanceof ApiError ? error.message : 'Something went wrong');
    } finally {
      this.busy.set(null);
    }
  }

  private take(view: NotificationSettingsView) {
    this.view.set(view);
    this.publicUrl.set(view.publicUrl ?? '');
  }
}
