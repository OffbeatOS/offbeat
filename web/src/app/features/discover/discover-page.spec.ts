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
  feedback: null,
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
  preferences: {
    defaultMode: 'balanced',
    sections: [
      { id: 'picks', visible: true },
      { id: 'albums', visible: true },
      { id: 'tags', visible: true },
    ],
  },
  ...extra,
});

async function render(body: DiscoverResponse, urlMode?: string) {
  TestBed.configureTestingModule({
    imports: [DiscoverPage],
    providers: [provideRouter([]), provideHttpClient(), provideHttpClientTesting()],
  });
  const fixture = TestBed.createComponent(DiscoverPage);
  if (urlMode) fixture.componentRef.setInput('mode', urlMode);
  fixture.detectChanges();
  // No mode in the URL: the server answers with the user's default.
  TestBed.inject(HttpTestingController).expectOne(urlMode ? `api/v1/discover?mode=${urlMode}` : 'api/v1/discover').flush(body);
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

  it('opens with the default mode from Settings, but a mode in the URL wins', async () => {
    const deeper = await render(response({ mode: 'deeper', preferences: { ...response().preferences, defaultMode: 'deeper' } }));
    expect(deeper.el.querySelector('.modes [aria-pressed="true"]')?.textContent?.trim()).toBe('Deeper');
    TestBed.resetTestingModule();
    const safer = await render(response({ mode: 'safer', preferences: { ...response().preferences, defaultMode: 'deeper' } }), 'safer');
    expect(safer.el.querySelector('.modes [aria-pressed="true"]')?.textContent?.trim()).toBe('Safer');
  });

  it('shows sections in the chosen order, leaving hidden ones out', async () => {
    const sections = [
      { id: 'tags', visible: true },
      { id: 'albums', visible: false },
      { id: 'picks', visible: true },
    ] as const;
    const { text } = await render(response({ preferences: { defaultMode: 'balanced', sections: [...sections] } }));
    expect(text('h2')).toEqual(['Explore by Tag', 'Top Picks for You']);
  });

  it('says so when every section is hidden', async () => {
    const sections = (['picks', 'albums', 'tags'] as const).map((id) => ({ id, visible: false }));
    const { el } = await render(response({ preferences: { defaultMode: 'balanced', sections } }));
    expect(el.querySelector('ob-empty-state')?.textContent).toContain('Every section is hidden');
    expect(el.querySelector('.to-settings a')?.getAttribute('href')).toBe('/settings/discovery');
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

describe('DiscoverPage feedback', () => {
  it('takes a thumbed-down pick away, and Undo puts it back where it was', async () => {
    const { el, text, fixture } = await render(response({ items: [pick('Lagwagon'), pick('Pennywise'), pick('Strung Out')] }));
    const http = TestBed.inject(HttpTestingController);
    el.querySelector<HTMLButtonElement>('[aria-label="Less like Pennywise"]')!.click();
    http.expectOne('api/v1/discover/feedback').flush(null, { status: 204, statusText: 'No Content' });
    await new Promise((resolve) => setTimeout(resolve));
    fixture.detectChanges();
    expect(text('.pick .name')).toEqual(['Lagwagon', 'Strung Out']);
    expect(el.querySelector('.undo')?.textContent).toContain('Pennywise is hidden');

    el.querySelector<HTMLButtonElement>('.undo button')!.click();
    http.expectOne('api/v1/discover/feedback').flush(null, { status: 204, statusText: 'No Content' });
    await new Promise((resolve) => setTimeout(resolve));
    fixture.detectChanges();
    expect(text('.pick .name')).toEqual(['Lagwagon', 'Pennywise', 'Strung Out']);
    // Changing the list never reloads it from the server.
    http.expectNone('api/v1/discover');
    http.verify();
  });
});
