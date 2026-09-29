import { ChangeDetectionStrategy, Component, computed, effect, inject, input, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import type { ReleaseSummary, TagAlbums, TagArtist, TagPage as TagPageData } from '@offbeat/shared';
import { Api, ApiError } from '../../core/api';
import { Cover } from '../../shared/catalog/cover';
import { QuickAdd } from '../../shared/catalog/quick-add';
import { EmptyState } from '../../shared/empty-state/empty-state';
import { Icon } from '../../shared/icon/icon';
import { PlayRelease } from '../../shared/player/play-release';
import { Toggle } from '../../shared/toggle/toggle';

const HIDE_KEY = 'offbeat.tag.hideLibrary';
/** Shown before See all. */
const FIRST = 6;

/**
 * Tag page (Tag mockup): the best-known artists with this genre, their
 * most played albums, and genres that go with it in the user's own
 * recommendations. Reached from Explore by Tag. The albums load after the
 * artists: the first visit to a tag takes several seconds to find them.
 */
@Component({
  selector: 'ob-tag-page',
  imports: [RouterLink, FormsModule, Cover, QuickAdd, EmptyState, Icon, Toggle, PlayRelease],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './tag-page.scss',
  templateUrl: './tag-page.html',
})
export class TagPage {
  private readonly api = inject(Api);

  /** Route parameter, via component input binding. */
  readonly tag = input.required<string>();

  protected readonly data = signal<TagPageData | null>(null);
  /** Null while loading. */
  protected readonly topAlbums = signal<ReleaseSummary[] | null>(null);
  protected readonly albumsError = signal(false);
  protected readonly error = signal('');
  protected readonly ghosts = [1, 2, 3, 4, 5, 6];
  protected readonly addError = signal('');
  protected readonly hideLibrary = signal(readHide());
  protected readonly allArtists = signal(false);
  protected readonly allAlbums = signal(false);
  private readonly addedNow = signal<ReadonlySet<string>>(new Set());

  private readonly libraryArtists = computed(() => {
    const added = this.addedNow();
    return new Set((this.data()?.artists ?? []).filter((a) => a.inLibrary || added.has(a.mbid)).map((a) => a.mbid));
  });
  protected readonly artists = computed(() => {
    const all = (this.data()?.artists ?? []).filter((a) => !this.hideLibrary() || !this.libraryArtists().has(a.mbid));
    return this.allArtists() ? all : all.slice(0, FIRST);
  });
  protected readonly moreArtists = computed(
    () => (this.data()?.artists ?? []).filter((a) => !this.hideLibrary() || !this.libraryArtists().has(a.mbid)).length > FIRST,
  );
  protected readonly albums = computed(() => {
    const all = (this.topAlbums() ?? []).filter((a) => !this.hideLibrary() || !this.libraryArtists().has(a.artistMbid));
    return this.allAlbums() ? all : all.slice(0, FIRST);
  });
  protected readonly moreAlbums = computed(
    () => (this.topAlbums() ?? []).filter((a) => !this.hideLibrary() || !this.libraryArtists().has(a.artistMbid)).length > FIRST,
  );

  constructor() {
    effect(() => void this.load(this.tag()));
    effect(() => {
      try {
        localStorage.setItem(HIDE_KEY, String(this.hideLibrary()));
      } catch {
        // storage unavailable: the choice lasts for this visit
      }
    });
  }

  protected note(artist: TagArtist): string {
    if (artist.inLibrary || this.addedNow().has(artist.mbid)) return 'In Library';
    return artist.recommended ? 'Recommended' : '';
  }

  protected isInLibrary(artist: TagArtist): boolean {
    return artist.inLibrary || this.addedNow().has(artist.mbid);
  }

  protected onAdded(artist: TagArtist) {
    this.addError.set('');
    this.addedNow.update((set) => new Set(set).add(artist.mbid));
  }

  private async load(tag: string) {
    this.data.set(null);
    this.topAlbums.set(null);
    this.albumsError.set(false);
    this.error.set('');
    this.allArtists.set(false);
    this.allAlbums.set(false);
    const path = `tags/${encodeURIComponent(tag)}`;
    let page: TagPageData;
    try {
      page = await this.api.get<TagPageData>(path);
    } catch (error) {
      if (tag === this.tag()) this.error.set(error instanceof ApiError ? error.message : 'Could not load this tag');
      return;
    }
    // Another tag was opened meanwhile: its own load owns the page now.
    if (tag !== this.tag()) return;
    this.data.set(page);
    if (!page.artists.length) return;
    try {
      const { albums } = await this.api.get<TagAlbums>(`${path}/albums`);
      if (tag === this.tag()) this.topAlbums.set(albums);
    } catch {
      if (tag === this.tag()) this.albumsError.set(true);
    }
  }
}

function readHide(): boolean {
  try {
    return localStorage.getItem(HIDE_KEY) !== 'false';
  } catch {
    return true;
  }
}
