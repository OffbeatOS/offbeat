import { Injectable, computed, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import type { ActivityItem, ActivitySnapshot, AddResult } from '@offbeat/shared';
import { Api } from './api';
import { Session } from './session';

const EMPTY: ActivitySnapshot = { attention: [], inProgress: [], completed: [], updatedAt: null, error: null };
const RECONNECT_MS = 5000;

/**
 * Live activity from the server's single Lidarr poller, over one
 * Server-Sent Events stream per tab. Shared by the bottom bar, the Activity
 * page, and status chips, so nothing else polls.
 */
@Injectable({ providedIn: 'root' })
export class ActivityStore {
  private readonly api = inject(Api);
  private readonly session = inject(Session);
  private readonly router = inject(Router);
  private source: EventSource | null = null;
  private reconnect: ReturnType<typeof setTimeout> | undefined;
  private users = 0;

  readonly snapshot = signal<ActivitySnapshot>(EMPTY);
  readonly connected = signal(false);
  /** Latest background add result per release group MBID. */
  readonly addResults = signal<ReadonlyMap<string, AddResult>>(new Map());

  /** Live item per release group MBID: needs attention wins over in progress. */
  readonly byAlbum = computed(() => {
    const map = new Map<string, ActivityItem>();
    const { attention, inProgress } = this.snapshot();
    for (const item of [...inProgress, ...attention]) if (item.albumMbid) map.set(item.albumMbid, item);
    return map;
  });

  /** The download to show in the bottom bar, and how many more are queued. */
  readonly current = computed(() => {
    const moving = this.snapshot().inProgress;
    const download =
      moving.find((i) => i.state === 'downloading') ??
      moving.find((i) => i.state === 'importing') ??
      moving.find((i) => i.state !== 'adding') ??
      moving[0] ??
      null;
    return { item: download, more: Math.max(0, moving.length - 1), attention: this.snapshot().attention.length };
  });

  /** Opens the stream while at least one component needs it. */
  connect(): () => void {
    this.users++;
    if (!this.source) this.open();
    return () => {
      this.users--;
      if (this.users === 0) this.close();
    };
  }

  async retry(id: string): Promise<void> {
    await this.api.post(`activity/${encodeURIComponent(id)}/retry`);
  }

  async cancel(id: string): Promise<void> {
    await this.api.delete(`activity/${encodeURIComponent(id)}`);
  }

  private open() {
    clearTimeout(this.reconnect);
    // No EventSource (old browsers, tests): activity simply stays empty.
    if (typeof EventSource === 'undefined') return;
    const source = new EventSource('api/v1/events');
    this.source = source;
    source.onopen = () => this.connected.set(true);
    source.addEventListener('activity', (event) => {
      this.snapshot.set(JSON.parse((event as MessageEvent<string>).data) as ActivitySnapshot);
    });
    source.addEventListener('add-result', (event) => {
      const result = JSON.parse((event as MessageEvent<string>).data) as AddResult;
      this.addResults.update((map) => new Map(map).set(result.albumMbid, result));
    });
    source.onerror = () => {
      this.connected.set(false);
      // The browser retries on its own unless the server refused the stream (for example a 401).
      if (source.readyState === EventSource.CLOSED) {
        this.source = null;
        void this.recover();
      }
    };
  }

  /** After a refused stream, check the session: expired means sign in again, otherwise retry later. */
  private async recover() {
    try {
      const me = await this.api.get<{ user: unknown }>('auth/me');
      if (!me.user) {
        this.session.signedOut();
        await this.router.navigate(['/login'], { queryParams: { returnUrl: this.router.url } });
        return;
      }
    } catch {
      // server unreachable; try again below
    }
    if (this.users > 0) this.reconnect = setTimeout(() => this.open(), RECONNECT_MS);
  }

  private close() {
    clearTimeout(this.reconnect);
    this.source?.close();
    this.source = null;
    this.connected.set(false);
  }
}
