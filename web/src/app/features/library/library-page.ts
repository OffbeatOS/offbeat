import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  type ElementRef,
  computed,
  effect,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import type { LibraryArtist, LibraryResponse } from '@offbeat/shared';
import { Api, ApiError } from '../../core/api';
import { EmptyState } from '../../shared/empty-state/empty-state';
import { timeAgo } from '../../shared/format';
import { Icon } from '../../shared/icon/icon';
import { ArtistCard } from './artist-card';

type Filter = 'all' | 'monitored' | 'missing' | 'recent';
type Sort = 'name-asc' | 'name-desc' | 'added-desc';
type View = 'grid' | 'list';

const FILTERS: { id: Filter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'monitored', label: 'Monitored' },
  { id: 'missing', label: 'Missing Albums' },
  { id: 'recent', label: 'Recently Added' },
];
const SORTS: { id: Sort; label: string }[] = [
  { id: 'name-asc', label: 'Name A to Z' },
  { id: 'name-desc', label: 'Name Z to A' },
  { id: 'added-desc', label: 'Newest added' },
];
const RECENT_DAYS = 30;
/** Cards rendered per batch; more are added as the end of the list scrolls into view. */
const BATCH = 140;
const VIEW_KEY = 'offbeat.library.view';

const collator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true });
const fold = (text: string) => text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

/**
 * Library mockup. Everything below the fetch works on the cached list in
 * memory: filtering and sorting never go back to Lidarr.
 */
@Component({
  selector: 'ob-library-page',
  imports: [ArtistCard, EmptyState, Icon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './library-page.scss',
  templateUrl: './library-page.html',
})
export class LibraryPage {
  private readonly api = inject(Api);

  protected readonly filters = FILTERS;
  protected readonly sorts = SORTS;

  protected readonly data = signal<LibraryResponse | null>(null);
  protected readonly loadError = signal('');
  protected readonly refreshing = signal(false);

  protected readonly filter = signal<Filter>('all');
  protected readonly sort = signal<Sort>('name-asc');
  protected readonly query = signal('');
  protected readonly view = signal<View>(readView());
  protected readonly visible = signal(BATCH);

  private readonly sentinel = viewChild<ElementRef<HTMLElement>>('sentinel');

  protected readonly total = computed(() => this.data()?.artists.length ?? 0);
  protected readonly syncing = computed(() => this.data()?.sync.state === 'syncing' || this.refreshing());

  protected readonly results = computed(() => {
    const artists = this.data()?.artists ?? [];
    const filter = this.filter();
    const needle = fold(this.query().trim());
    const recentCutoff = Date.now() - RECENT_DAYS * 86_400_000;
    const matches = artists.filter((artist) => {
      if (filter === 'monitored' && !artist.monitored) return false;
      if (filter === 'missing' && artist.missingAlbums === 0) return false;
      if (filter === 'recent' && Date.parse(artist.addedAt) < recentCutoff) return false;
      return !needle || fold(artist.name).includes(needle);
    });
    return matches.sort(comparator(this.sort()));
  });

  protected readonly shown = computed(() => this.results().slice(0, this.visible()));

  /** Stale data with a failed refresh: show it, with a quiet notice. */
  protected readonly staleNotice = computed(() => {
    const data = this.data();
    if (!data || data.sync.state !== 'error' || !data.sync.lastSyncedAt) return '';
    return `Could not reach Lidarr. Showing the library from ${timeAgo(data.sync.lastSyncedAt)}.`;
  });

  /** Lidarr was never reached: nothing cached to show. */
  protected readonly neverSynced = computed(() => {
    const data = this.data();
    return !!data && data.sync.state === 'error' && !data.sync.lastSyncedAt;
  });

  constructor() {
    void this.load();

    // Grow the rendered list as its end approaches the viewport. Without
    // IntersectionObserver (old browsers, tests), everything renders at once.
    const observer =
      typeof IntersectionObserver === 'undefined'
        ? null
        : new IntersectionObserver(
            (entries) => {
              if (entries.some((e) => e.isIntersecting) && this.visible() < this.results().length) {
                this.visible.update((n) => n + BATCH);
              }
            },
            { rootMargin: '800px 0px' },
          );

    // New filter, sort, or search: start from the first batch again.
    effect(() => {
      this.filter();
      this.sort();
      this.query();
      this.visible.set(observer ? BATCH : Infinity);
    });

    effect(() => {
      observer?.disconnect();
      const el = this.sentinel()?.nativeElement;
      if (el) observer?.observe(el);
    });

    // While Lidarr is being synced (for example right after setup), check back.
    let poll: ReturnType<typeof setTimeout> | undefined;
    effect(() => {
      clearTimeout(poll);
      if (this.data()?.sync.state === 'syncing') poll = setTimeout(() => void this.load(), 2000);
    });

    inject(DestroyRef).onDestroy(() => {
      observer?.disconnect();
      clearTimeout(poll);
    });
  }

  protected setFilter(filter: Filter) {
    this.filter.set(filter);
    // "Recently Added" reads best newest first.
    if (filter === 'recent') this.sort.set('added-desc');
  }

  protected setView(view: View) {
    this.view.set(view);
    try {
      localStorage.setItem(VIEW_KEY, view);
    } catch {
      // storage unavailable (private mode); the choice just is not remembered
    }
  }

  protected clearFilters() {
    this.filter.set('all');
    this.query.set('');
  }

  protected async refresh() {
    this.refreshing.set(true);
    try {
      this.data.set(await this.api.post<LibraryResponse>('library/refresh'));
      this.loadError.set('');
    } catch (error) {
      this.loadError.set(error instanceof ApiError ? error.message : 'Could not refresh the library');
    } finally {
      this.refreshing.set(false);
    }
  }

  protected async load() {
    try {
      this.data.set(await this.api.get<LibraryResponse>('library'));
      this.loadError.set('');
    } catch (error) {
      this.loadError.set(error instanceof ApiError ? error.message : 'Could not load the library');
    }
  }

  protected onQuery(event: Event) {
    this.query.set((event.target as HTMLInputElement).value);
  }

  protected onSort(event: Event) {
    this.sort.set((event.target as HTMLSelectElement).value as Sort);
  }

  protected countLabel() {
    const total = this.total();
    const matched = this.results().length;
    const noun = total === 1 ? 'artist' : 'artists';
    return matched === total ? `${total} ${noun}` : `${matched} of ${total} ${noun}`;
  }
}

function comparator(sort: Sort) {
  switch (sort) {
    case 'name-desc':
      return (a: LibraryArtist, b: LibraryArtist) => collator.compare(b.sortName, a.sortName);
    case 'added-desc':
      return (a: LibraryArtist, b: LibraryArtist) => b.addedAt.localeCompare(a.addedAt);
    default:
      return (a: LibraryArtist, b: LibraryArtist) => collator.compare(a.sortName, b.sortName);
  }
}

function readView(): View {
  try {
    return localStorage.getItem(VIEW_KEY) === 'list' ? 'list' : 'grid';
  } catch {
    return 'grid';
  }
}
