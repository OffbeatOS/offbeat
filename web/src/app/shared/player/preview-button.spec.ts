import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import type { ArtistPreview, CurrentUser } from '@offbeat/shared';
import { Player } from '../../core/player';
import { Session } from '../../core/session';
import { PreviewButton } from './preview-button';

const PREVIEW: ArtistPreview = {
  artistMbid: 'a-pennywise',
  artistName: 'Pennywise',
  deezerUrl: 'https://www.deezer.com/artist/3',
  tracks: [{ deezerTrackId: 301, title: 'Bro Hymn', albumTitle: 'Full Circle', coverUrl: null, durationMs: 30_000, audioUrl: 'api/v1/previews/301/audio' }],
};

function render(inputs: { inLibrary?: boolean; look?: 'round' | 'pill'; permissions?: string[] } = {}) {
  TestBed.configureTestingModule({ imports: [PreviewButton], providers: [provideHttpClient(), provideHttpClientTesting()] });
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined);
  vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => undefined);
  const user = { id: 2, username: 'sam', role: 'user', permissions: inputs.permissions ?? ['stream'], mustChangePassword: false } as CurrentUser;
  TestBed.inject(Session).user.set(user);
  const fixture = TestBed.createComponent(PreviewButton);
  fixture.componentRef.setInput('mbid', 'a-pennywise');
  fixture.componentRef.setInput('name', 'Pennywise');
  if (inputs.inLibrary !== undefined) fixture.componentRef.setInput('inLibrary', inputs.inLibrary);
  if (inputs.look) fixture.componentRef.setInput('look', inputs.look);
  fixture.detectChanges();
  const settle = async () => {
    await new Promise((resolve) => setTimeout(resolve));
    await fixture.whenStable();
    fixture.detectChanges();
  };
  return { fixture, settle, http: TestBed.inject(HttpTestingController), el: fixture.nativeElement as HTMLElement };
}

describe('PreviewButton', () => {
  afterEach(() => {
    TestBed.inject(Player).stop();
    vi.restoreAllMocks();
  });

  it('plays the artist\'s previews', async () => {
    const { el, http, settle } = render();
    expect(el.hidden).toBe(false);
    el.querySelector('button')!.click();
    http.expectOne('api/v1/artists/a-pennywise/preview?name=Pennywise').flush(PREVIEW);
    await settle();
    expect(TestBed.inject(Player).current()?.title).toBe('Bro Hymn');
  });

  it('is not offered for artists in the library, or without the Stream permission', () => {
    expect(render({ inLibrary: true }).el.hidden).toBe(true);
    TestBed.resetTestingModule();
    expect(render({ permissions: [] }).el.hidden).toBe(true);
  });

  it('hides over a card, and says so on the artist page, when Deezer has no match', async () => {
    const round = render();
    round.el.querySelector('button')!.click();
    round.http.expectOne(() => true).flush({ error: 'Not Found', message: 'No preview for this artist' }, { status: 404, statusText: 'Not Found' });
    await round.settle();
    expect(round.el.hidden).toBe(true);

    TestBed.resetTestingModule();
    const pill = render({ look: 'pill' });
    pill.el.querySelector('button')!.click();
    pill.http.expectOne(() => true).flush({ error: 'Not Found', message: 'No preview for this artist' }, { status: 404, statusText: 'Not Found' });
    await pill.settle();
    expect(pill.el.hidden).toBe(false);
    expect(pill.el.querySelector('button')?.textContent?.trim()).toBe('No preview');
    expect(pill.el.querySelector('button')?.disabled).toBe(true);
  });
});
