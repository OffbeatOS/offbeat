import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import type { LibraryArtist, LibraryResponse } from '@offbeat/shared';
import { LibraryPage } from './library-page';

function artist(id: number, name: string, extra: Partial<LibraryArtist> = {}): LibraryArtist {
  return {
    id,
    mbid: `mbid-${id}`,
    name,
    sortName: name.replace(/^The /, '').toLowerCase(),
    monitored: true,
    addedAt: '2020-01-01T00:00:00.000Z',
    albumCount: 3,
    missingAlbums: 0,
    sizeOnDisk: 1024 ** 3,
    genres: [],
    imageUrl: `api/v1/images/artist/${id}?v=abc`,
    ...extra,
  };
}

async function render(response: LibraryResponse) {
  TestBed.configureTestingModule({
    imports: [LibraryPage],
    providers: [provideRouter([]), provideHttpClient(), provideHttpClientTesting()],
  });
  const fixture = TestBed.createComponent(LibraryPage);
  TestBed.inject(HttpTestingController).expectOne('api/v1/library').flush(response);
  await fixture.whenStable();
  fixture.detectChanges();
  const el = fixture.nativeElement as HTMLElement;
  const names = () => [...el.querySelectorAll('ob-artist-card .name')].map((n) => n.textContent?.trim());
  const click = async (label: string) => {
    [...el.querySelectorAll<HTMLButtonElement>('.pills button')].find((b) => b.textContent?.trim() === label)?.click();
    await fixture.whenStable();
    fixture.detectChanges();
  };
  return { el, names, click };
}

const ok = { state: 'ok' as const, lastSyncedAt: new Date().toISOString(), error: null };

describe('LibraryPage', () => {
  it('sorts by Lidarr sort name, so "The Cure" sorts under C', async () => {
    const { names, el } = await render({
      sync: ok,
      artists: [artist(1, 'Radiohead'), artist(2, 'The Cure'), artist(3, 'Burial')],
    });
    expect(names()).toEqual(['Burial', 'The Cure', 'Radiohead']);
    expect(el.querySelector('.count')?.textContent?.trim()).toBe('3 artists');
  });

  it('filters missing albums and shows status notes', async () => {
    const { names, click, el } = await render({
      sync: ok,
      artists: [
        artist(1, 'Boards of Canada', { missingAlbums: 2 }),
        artist(2, 'Slowdive', { monitored: false }),
        artist(3, 'Sade'),
      ],
    });
    const notes = [...el.querySelectorAll('ob-artist-card .note')].map((n) => n.textContent?.trim());
    expect(notes).toEqual(['2 missing', '', 'Unmonitored']);

    await click('Missing Albums');
    expect(names()).toEqual(['Boards of Canada']);
    expect(el.querySelector('.count')?.textContent?.trim()).toBe('1 of 3 artists');

    await click('Monitored');
    expect(names()).toEqual(['Boards of Canada', 'Sade']);
  });

  it('only ever points images at the Offbeat proxy', async () => {
    const { el } = await render({ sync: ok, artists: [artist(1, 'Burial')] });
    const src = el.querySelector('ob-artist-card img')?.getAttribute('src');
    expect(src).toBe('api/v1/images/artist/1?v=abc');
  });

  it('shows an empty state for a Lidarr with no artists', async () => {
    const { el } = await render({ sync: ok, artists: [] });
    expect(el.querySelector('ob-empty-state h2')?.textContent).toBe('No artists yet');
  });

  it('keeps cached artists visible with a quiet notice when Lidarr is unreachable', async () => {
    const { el, names } = await render({
      sync: { state: 'error', lastSyncedAt: new Date(Date.now() - 3 * 3600_000).toISOString(), error: 'Nothing is listening' },
      artists: [artist(1, 'Burial')],
    });
    expect(names()).toEqual(['Burial']);
    expect(el.querySelector('.notice')?.textContent).toContain('Could not reach Lidarr. Showing the library from 3 hours ago.');
  });

  it('explains when Lidarr has never been reached', async () => {
    const { el } = await render({
      sync: { state: 'error', lastSyncedAt: null, error: 'Nothing is listening at lidarr:8686.' },
      artists: [],
    });
    expect(el.querySelector('ob-empty-state h2')?.textContent).toBe('Could not reach Lidarr');
    expect(el.querySelector('ob-empty-state p')?.textContent).toContain('Nothing is listening');
  });
});
