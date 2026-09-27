import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import type { AlbumDetail } from '@offbeat/shared';
import { AlbumPage } from './album-page';

const MBID = '11111111-0000-4000-8000-000000000002';

function album(extra: Partial<AlbumDetail>): AlbumDetail {
  return {
    mbid: MBID,
    title: 'Untrue',
    type: 'Album',
    year: 2007,
    coverUrl: null,
    artistMbid: '22222222-0000-4000-8000-000000000000',
    artistName: 'Burial',
    status: { kind: 'available' },
    artistInLibrary: true,
    monitored: null,
    trackFileCount: null,
    trackCount: null,
    genres: ['Future Garage'],
    tracks: [
      { position: '1', title: 'Untitled', durationMs: null, hasFile: null },
      { position: '2', title: 'Archangel', durationMs: null, hasFile: null },
    ],
    more: [],
    ...extra,
  };
}

async function render(detail: AlbumDetail) {
  TestBed.configureTestingModule({
    imports: [AlbumPage],
    providers: [provideRouter([]), provideHttpClient(), provideHttpClientTesting()],
  });
  const fixture = TestBed.createComponent(AlbumPage);
  fixture.componentRef.setInput('mbid', MBID);
  fixture.detectChanges();
  TestBed.inject(HttpTestingController).expectOne(`api/v1/albums/${MBID}`).flush(detail);
  // The response resolves a promise chain; let it settle before rendering.
  await new Promise((resolve) => setTimeout(resolve));
  await fixture.whenStable();
  fixture.detectChanges();
  const el = fixture.nativeElement as HTMLElement;
  return {
    status: () => el.querySelector('.status')?.textContent?.trim() ?? null,
    buttons: () => [...el.querySelectorAll('.actions button')].map((b) => b.textContent?.trim()),
    statusColumn: () => !!el.querySelector('.track-head .right'),
    missingTitles: () => [...el.querySelectorAll('li.missing .title')].map((t) => t.textContent?.trim()),
    meta: () => el.querySelector('.meta')?.textContent?.trim(),
  };
}

describe('AlbumPage states', () => {
  it('not in Lidarr: Add Album, no status line or status column', async () => {
    const page = await render(album({ artistInLibrary: false }));
    expect(page.buttons()).toEqual(['Add Album']);
    expect(page.status()).toBeNull();
    expect(page.statusColumn()).toBe(false);
    expect(page.meta()).toBe('2007, 2 tracks, Future Garage');
  });

  it('partial: status line, Monitored and Search Missing, only missing tracks marked', async () => {
    const page = await render(
      album({
        monitored: true,
        trackFileCount: 1,
        trackCount: 2,
        status: { kind: 'partial', missingTracks: 1 },
        tracks: [
          { position: '1', title: 'Untitled', durationMs: null, hasFile: true },
          { position: '2', title: 'Archangel', durationMs: null, hasFile: false },
        ],
      }),
    );
    expect(page.status()).toBe('Partial: 1 of 2 tracks in library');
    expect(page.buttons()).toEqual(['Monitored', 'Search Missing']);
    expect(page.statusColumn()).toBe(true);
    expect(page.missingTitles()).toEqual(['Archangel']);
  });

  it('wanted: monitored with no files', async () => {
    const page = await render(album({ monitored: true, trackFileCount: 0, trackCount: 2, status: { kind: 'requested' } }));
    expect(page.status()).toBe('Wanted');
    expect(page.buttons()).toEqual(['Monitored', 'Search Missing']);
  });

  it('complete: no status line, just Monitored', async () => {
    const page = await render(album({ monitored: true, trackFileCount: 2, trackCount: 2, status: { kind: 'in-library' } }));
    expect(page.status()).toBeNull();
    expect(page.buttons()).toEqual(['Monitored']);
  });

  it('in Lidarr but unmonitored with nothing on disk: offers Add Album', async () => {
    const page = await render(
      album({
        monitored: false,
        trackFileCount: 0,
        trackCount: 2,
        tracks: [{ position: '1', title: 'Untitled', durationMs: null, hasFile: false }],
      }),
    );
    expect(page.buttons()).toEqual(['Add Album']);
    expect(page.statusColumn()).toBe(false);
    expect(page.missingTitles()).toEqual([]);
  });
});
