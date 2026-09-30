import { ChangeDetectionStrategy, Component, computed, effect, inject, input, signal } from '@angular/core';
import type { ArtistDetail, ReleaseType, UpdateArtistRequest } from '@offbeat/shared';
import { Api, ApiError } from '../../core/api';
import { AlbumCard } from '../../shared/catalog/album-card';
import { EmptyState } from '../../shared/empty-state/empty-state';
import { Icon } from '../../shared/icon/icon';
import { PreviewButton } from '../../shared/player/preview-button';
import { Session } from '../../core/session';

type TypeFilter = 'All' | ReleaseType;
const FILTER_LABELS: Record<string, string> = { All: 'All', Album: 'Albums', EP: 'EPs', Compilation: 'Compilations' };

/**
 * Artist mockup, keyed by MusicBrainz id so the same page works before and
 * after adding. Library artists show Lidarr's status per album; others show
 * their MusicBrainz discography with Add buttons.
 */
@Component({
  selector: 'ob-artist-page',
  imports: [AlbumCard, EmptyState, Icon, PreviewButton],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './artist-page.scss',
  templateUrl: './artist-page.html',
})
export class ArtistPage {
  private readonly api = inject(Api);
  /** Hides what the server would refuse this user (see Session.can). */
  protected readonly can = inject(Session).can;

  /** Route parameter, via component input binding. */
  readonly mbid = input.required<string>();

  protected readonly artist = signal<ArtistDetail | null>(null);
  protected readonly loadError = signal<{ status: number; message: string } | null>(null);
  protected readonly busy = signal(false);
  protected readonly actionError = signal('');
  protected readonly filter = signal<TypeFilter>('All');
  protected readonly bannerFailed = signal(false);

  /** Only offer filters for types this artist actually has. */
  protected readonly filters = computed(() => {
    const types = new Set(this.artist()?.releases.map((r) => r.type));
    return (['All', 'Album', 'EP', 'Compilation'] as const)
      .filter((t) => t === 'All' || types.has(t))
      .map((id) => ({ id, label: FILTER_LABELS[id]! }));
  });

  protected readonly releases = computed(() => {
    const filter = this.filter();
    const releases = this.artist()?.releases ?? [];
    return filter === 'All' ? releases : releases.filter((r) => r.type === filter);
  });

  constructor() {
    // Reload when navigating from one artist to another (same component instance).
    effect(() => {
      const mbid = this.mbid();
      void this.load(mbid);
    });
  }

  protected async load(mbid = this.mbid()) {
    this.artist.set(null);
    this.loadError.set(null);
    this.filter.set('All');
    this.bannerFailed.set(false);
    try {
      this.artist.set(await this.api.get<ArtistDetail>(`artists/${mbid}`));
    } catch (error) {
      this.loadError.set(
        error instanceof ApiError ? { status: error.status, message: error.message } : { status: 0, message: 'Something went wrong' },
      );
    }
  }

  protected async addArtist() {
    await this.act(() => this.api.post<ArtistDetail>(`artists/${this.mbid()}`));
  }

  protected async toggleMonitored() {
    const monitored = !this.artist()?.monitored;
    const body: UpdateArtistRequest = { monitored };
    await this.act(() => this.api.patch<ArtistDetail>(`artists/${this.mbid()}`, body));
  }

  /** After a single album add, refresh so the header and other albums reflect it. */
  protected async onAlbumAdded() {
    try {
      this.artist.set(await this.api.get<ArtistDetail>(`artists/${this.mbid()}`));
    } catch {
      // the card already shows its new status; a failed refresh is not worth an error
    }
  }

  private async act(run: () => Promise<ArtistDetail>) {
    if (this.busy()) return;
    this.busy.set(true);
    this.actionError.set('');
    try {
      this.artist.set(await run());
    } catch (error) {
      this.actionError.set(error instanceof ApiError ? error.message : 'Something went wrong');
    } finally {
      this.busy.set(false);
    }
  }
}
