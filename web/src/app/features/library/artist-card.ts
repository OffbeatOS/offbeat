import { ChangeDetectionStrategy, Component, computed, input, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import type { LibraryArtist } from '@offbeat/shared';
import { formatBytes } from '../../shared/format';

/**
 * Library artist, as a circle card (grid) or a list row. Artwork loads lazily
 * through Offbeat's image proxy; the initial shows until it arrives or if it fails.
 */
@Component({
  selector: 'ob-artist-card',
  imports: [RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './artist-card.scss',
  template: `
    <a [routerLink]="['/artist', artist().mbid]" [class.row]="layout() === 'list'">
      <span class="art" aria-hidden="true">
        <span class="initial">{{ initial() }}</span>
        @if (artist().imageUrl && !imageFailed()) {
          <img
            [src]="artist().imageUrl"
            alt=""
            loading="lazy"
            decoding="async"
            [class.loaded]="imageLoaded()"
            (load)="imageLoaded.set(true)"
            (error)="imageFailed.set(true)"
          />
        }
      </span>
      <span class="text">
        <span class="name">{{ artist().name }}</span>
        @if (layout() === 'list') {
          <span class="meta">{{ meta() }}</span>
        }
        <span class="note">{{ noteText() }}</span>
      </span>
    </a>
  `,
})
export class ArtistCard {
  readonly artist = input.required<LibraryArtist>();
  readonly layout = input<'grid' | 'list'>('grid');

  protected readonly imageLoaded = signal(false);
  protected readonly imageFailed = signal(false);

  protected readonly initial = computed(() => this.artist().name.replace(/^the\s+/i, '').charAt(0).toUpperCase());

  /** Status chip rules: missing albums first, then unmonitored. Downloading arrives with queue data. */
  protected readonly note = computed(() => {
    const { missingAlbums, monitored } = this.artist();
    if (missingAlbums > 0) return `${missingAlbums} missing`;
    if (!monitored) return 'Unmonitored';
    return '';
  });

  /** A non-breaking space keeps rows aligned when there is nothing to say. */
  protected readonly noteText = computed(() => this.note() || '\u00a0');

  protected readonly meta = computed(() => {
    const { albumCount, sizeOnDisk } = this.artist();
    return `${albumCount} ${albumCount === 1 ? 'album' : 'albums'}, ${formatBytes(sizeOnDisk)}`;
  });
}
