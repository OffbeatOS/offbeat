import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import type { DiscoverPick, DiscoverResponse } from '@offbeat/shared';
import { DiscoverPage } from './discover-page';
import { refreshedLabel } from './refreshed-label';

const pick = (name: string, extra: Partial<DiscoverPick> = {}): DiscoverPick => ({
  mbid: `00000000-0000-4000-8000-${name.length.toString().padStart(12, '0')}`,
  name,
  disambiguation: null,
  genres: ['Punk Rock', 'Skate Punk', 'Ska Punk'],
  imageUrl: null,
  score: 90,
  reason: { seed: 'NOFX', seedMbid: 'm', via: null },
  seeds: ['NOFX'],
  sources: ['listenbrainz'],
  listeners: 50_000,
  inLibrary: false,
  ...extra,
});

const response = (extra: Partial<DiscoverResponse> = {}): DiscoverResponse => ({
  mode: 'balanced',
  generatedAt: new Date().toISOString(),
  refreshing: false,
  error: null,
  seedCount: 4,
  sources: { listenbrainz: true, lastfm: false },
  items: [pick('Lagwagon'), pick('Good Riddance', { reason: { seed: 'NOFX', seedMbid: 'm', via: 'Lagwagon' } })],
  albums: [
    {
      mbid: '11111111-0000-4000-8000-000000000001',
      title: 'Let’s Talk About Feelings',
      type: 'Album',
      year: 1998,
      coverUrl: null,
      artistMbid: 'a',
      artistName: 'Lagwagon',
      status: { kind: 'available' },
    },
  ],
  albumsPending: false,
  tags: ['Punk Rock', 'Skate Punk'],
  ...extra,
});

async function render(body: DiscoverResponse) {
  TestBed.configureTestingModule({
    imports: [DiscoverPage],
    providers: [provideRouter([]), provideHttpClient(), provideHttpClientTesting()],
  });
  const fixture = TestBed.createComponent(DiscoverPage);
  fixture.detectChanges();
  TestBed.inject(HttpTestingController).expectOne('api/v1/discover?mode=balanced').flush(body);
  await new Promise((resolve) => setTimeout(resolve));
  await fixture.whenStable();
  fixture.detectChanges();
  const el = fixture.nativeElement as HTMLElement;
  return { el, text: (selector: string) => [...el.querySelectorAll(selector)].map((n) => n.textContent?.trim()), fixture };
}

describe('DiscoverPage', () => {
  it('shows picks with their reasons, albums to start with, and tags to explore', async () => {
    const { el, text } = await render(response());
    expect(text('h2')).toEqual(['Top Picks for You', 'Albums to Start With', 'Explore by Tag']);
    expect(text('.pick .reason')).toEqual(['Because you like NOFX', 'Lagwagon, like NOFX']);
    expect(text('.pick .genres')).toEqual(['Punk Rock, Skate Punk', 'Punk Rock, Skate Punk']);
    expect(text('.album .title')).toEqual(['Let’s Talk About Feelings']);
    expect(el.querySelector('.tag')?.getAttribute('href')).toBe('/tag/Punk%20Rock');
    expect(el.querySelector('.modes [aria-pressed="true"]')?.textContent?.trim()).toBe('Balanced');
  });

  it('suggests Last.fm when the picks come from ListenBrainz alone', async () => {
    expect((await render(response())).el.querySelector('.upgrade')?.textContent).toContain('These picks come from ListenBrainz');
    TestBed.resetTestingModule();
    expect((await render(response({ sources: { listenbrainz: true, lastfm: true } }))).el.querySelector('.upgrade')).toBeNull();
  });

  it('shows Top Picks while albums are still being found', async () => {
    const { el, text } = await render(response({ refreshing: true, albums: [], albumsPending: true }));
    expect(text('.pick .name')).toEqual(['Lagwagon', 'Good Riddance']);
    expect(el.querySelectorAll('.album-ghost')).toHaveLength(6);
    expect(el.textContent).toContain('Finding albums');
  });

  it('explains the wait while the first refresh runs', async () => {
    const { el } = await render(response({ generatedAt: null, refreshing: true, items: [], albums: [], tags: [] }));
    expect(el.querySelector('.first-run')?.textContent).toContain('Finding artists for you');
  });

  it('asks for library artists when there is nothing to go on', async () => {
    const { el } = await render(response({ seedCount: 0, items: [], albums: [], tags: [] }));
    expect(el.querySelector('ob-empty-state')?.textContent).toContain('Nothing to go on yet');
  });
});

describe('refreshedLabel', () => {
  it('speaks like the mockup', () => {
    const now = new Date(2026, 8, 27, 20, 0);
    expect(refreshedLabel(new Date(2026, 8, 27, 4, 0).toISOString(), now)).toBe('Refreshed this morning');
    expect(refreshedLabel(new Date(2026, 8, 27, 19, 30).toISOString(), now)).toBe('Refreshed just now');
    expect(refreshedLabel(new Date(2026, 8, 26, 4, 0).toISOString(), now)).toBe('Refreshed yesterday');
    expect(refreshedLabel(new Date(2026, 8, 24, 4, 0).toISOString(), now)).toBe('Refreshed 3 days ago');
  });
});
