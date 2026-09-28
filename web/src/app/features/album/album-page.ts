import { ChangeDetectionStrategy, Component, computed, effect, inject, input, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import type { AddAlbumRequest, AddResult, AlbumDetail, UpdateAlbumRequest } from '@offbeat/shared';
import { ActivityStore } from '../../core/activity-store';
import { Api, ApiError } from '../../core/api';
import { STATE_LABEL, percent, stateTone } from '../../shared/catalog/activity-labels';
import { AlbumCard } from '../../shared/catalog/album-card';
import { Cover } from '../../shared/catalog/cover';
import { EmptyState } from '../../shared/empty-state/empty-state';
import { Icon } from '../../shared/icon/icon';

/**
 * Album mockup. The layout is shared by every state:
 * - not in Lidarr (or unmonitored with nothing on disk): coral Add Album, no status column
 * - wanted (monitored, no files): "Wanted", Search Missing
 * - partial: "Partial: 11 of 13 tracks in library", Search Missing, missing tracks marked
 * - complete: no status line, Monitored
 * Downloading progress arrives with queue data in the Activity slice.
 */
@Component({
  selector: 'ob-album-page',
  imports: [RouterLink, AlbumCard, Cover, EmptyState, Icon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './album-page.scss',
  templateUrl: './album-page.html',
})
export class AlbumPage {
  private readonly api = inject(Api);
  readonly mbid = input.required<string>();

  protected readonly album = signal<AlbumDetail | null>(null);
  protected readonly loadError = signal<{ status: number; message: string } | null>(null);
  protected readonly busy = signal<'add' | 'monitor' | 'search' | null>(null);
  protected readonly actionError = signal('');
  /** Why adding needs a second click (the server's 409), or empty. */
  protected readonly confirmAdd = signal('');
  protected readonly searchQueued = signal(false);

  /** In Lidarr means Lidarr knows the album; otherwise the page offers Add Album. */
  protected readonly inLidarr = computed(() => this.album()?.monitored !== null && this.album()?.monitored !== undefined);

  /** Track status only once the album is wanted: an album you have not added has nothing "missing". */
  /** Only missing tracks are marked, so a complete album gets a plain tracklist (no Status column). */
  protected readonly showTrackStatus = computed(() => this.inLidarr() && !this.canAdd() && this.missing() > 0);

  protected readonly canAdd = computed(() => {
    const album = this.album();
    if (!album) return false;
    return album.monitored === null || (!album.monitored && (album.trackFileCount ?? 0) === 0);
  });

  protected readonly missing = computed(() => {
    const album = this.album();
    if (!album || album.trackCount === null || album.trackFileCount === null) return 0;
    return Math.max(0, album.trackCount - album.trackFileCount);
  });

  /** "Partial: 11 of 13 tracks in library", "Wanted", or nothing when complete or not in Lidarr. */
  protected readonly statusLine = computed(() => {
    const album = this.album();
    if (!album || this.canAdd() || album.trackCount === null || album.trackFileCount === null) return '';
    if (album.trackFileCount === 0) return album.monitored ? 'Wanted' : '';
    if (this.missing() === 0) return '';
    return `Partial: ${album.trackFileCount} of ${album.trackCount} tracks in library`;
  });

  protected readonly meta = computed(() => {
    const album = this.album();
    if (!album) return '';
    const count = album.trackCount ?? album.tracks.length;
    return [album.year ? String(album.year) : '', count ? `${count} ${count === 1 ? 'track' : 'tracks'}` : '', album.genres[0] ?? '']
      .filter(Boolean)
      .join(', ');
  });

  private readonly store = inject(ActivityStore);
  /** Whether the activity stream had this album last time, to notice when it leaves. */
  private wasActive = false;
  private addBaseline: AddResult | undefined;
  private waitingForAdd = false;

  /** Searching, downloading, or blocked, live from the activity stream. */
  protected readonly live = computed(() => {
    const album = this.album();
    const item = album ? this.store.byAlbum().get(album.mbid) : undefined;
    return item && item.state !== 'adding' && album?.status.kind !== 'in-library' ? item : null;
  });
  protected readonly liveLabel = computed(() => {
    const item = this.live();
    if (!item) return '';
    const pct = item.state === 'downloading' && item.progress !== null ? ` ${percent(item.progress)}` : '';
    return `${STATE_LABEL[item.state]}${pct}`;
  });
  protected readonly liveTone = computed(() => (this.live() ? stateTone(this.live()!.state) : 'progress'));
  protected readonly adding = computed(() => this.album()?.status.kind === 'adding' || this.busy() === 'add');

  constructor() {
    effect(() => void this.load(this.mbid()));
    // Imported, removed, or retried: reload to show the album as Lidarr now has it.
    effect(() => {
      const album = this.album();
      const item = album ? this.store.byAlbum().get(album.mbid) : undefined;
      const active = !!item && item.state !== 'adding';
      if (this.wasActive && !active) void this.reload();
      this.wasActive = active;
    });
    // A background add finished: reload to show the album as Lidarr now has it.
    effect(() => {
      const album = this.album();
      const result = album ? this.store.addResults().get(album.mbid) : undefined;
      if (!this.waitingForAdd || !result || result === this.addBaseline) return;
      this.waitingForAdd = false;
      if (result.ok) void this.reload();
      else {
        this.album.update((a) => (a ? { ...a, status: { kind: 'available' } } : a));
        this.actionError.set(result.error ?? 'Could not add this album');
      }
    });
  }

  /** Refreshes the album in place, without the loading state. */
  private async reload() {
    try {
      this.album.set(await this.api.get<AlbumDetail>(`albums/${this.mbid()}`));
    } catch {
      // keep what is on screen
    }
  }

  protected async load(mbid = this.mbid()) {
    this.album.set(null);
    this.loadError.set(null);
    this.actionError.set('');
    this.searchQueued.set(false);
    try {
      this.album.set(await this.api.get<AlbumDetail>(`albums/${mbid}`));
    } catch (error) {
      this.loadError.set(
        error instanceof ApiError ? { status: error.status, message: error.message } : { status: 0, message: 'Something went wrong' },
      );
    }
  }

  /** Starts the add and returns at once; the result arrives over the activity stream. */
  protected async add(resumeMonitoring = false) {
    const album = this.album();
    if (!album || this.adding()) return;
    this.actionError.set('');
    this.confirmAdd.set('');
    this.addBaseline = this.store.addResults().get(album.mbid);
    this.waitingForAdd = true;
    this.album.set({ ...album, status: { kind: 'adding' } });
    try {
      const body: AddAlbumRequest = { artistMbid: album.artistMbid, resumeMonitoring };
      await this.api.post(`albums/${album.mbid}`, body);
    } catch (error) {
      this.waitingForAdd = false;
      this.album.set(album);
      // Adding would resume other albums the user left monitored: ask first.
      if (error instanceof ApiError && error.status === 409) this.confirmAdd.set(error.message);
      else this.actionError.set(error instanceof ApiError ? error.message : 'Could not add this album');
    }
  }

  protected toggleMonitored() {
    const album = this.album();
    if (!album) return;
    const body: UpdateAlbumRequest = { monitored: !album.monitored };
    void this.act('monitor', () => this.api.patch<AlbumDetail>(`albums/${album.mbid}`, body));
  }

  protected async searchMissing() {
    const album = this.album();
    if (!album || this.busy()) return;
    this.busy.set('search');
    this.actionError.set('');
    try {
      await this.api.post(`albums/${album.mbid}/search`);
      this.searchQueued.set(true);
    } catch (error) {
      this.actionError.set(error instanceof ApiError ? error.message : 'Could not start a search');
    } finally {
      this.busy.set(null);
    }
  }

  private async act(kind: 'add' | 'monitor', run: () => Promise<AlbumDetail>) {
    if (this.busy()) return;
    this.busy.set(kind);
    this.actionError.set('');
    try {
      this.album.set(await run());
    } catch (error) {
      this.actionError.set(error instanceof ApiError ? error.message : 'Something went wrong');
    } finally {
      this.busy.set(null);
    }
  }
}
