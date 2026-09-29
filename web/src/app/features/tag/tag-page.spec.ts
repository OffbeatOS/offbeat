import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import type { ReleaseSummary, TagArtist, TagPage as TagPageData } from '@offbeat/shared';
import { TagPage } from './tag-page';

const artist = (name: string, extra: Partial<TagArtist> = {}): TagArtist => ({
  mbid: `mbid-${name}`,
  name,
  disambiguation: null,
  imageUrl: null,
  inLibrary: false,
  recommended: false,
  ...extra,
});

const DATA: TagPageData = {
  tag: 'Pop Punk',
  artists: [artist('Green Day'), artist('Weezer', { recommended: true }), artist('The Offspring', { inLibrary: true })],
  related: ['Punk Rock'],
};

const album = (title: string, artistName: string): ReleaseSummary => ({
  mbid: `rg-${title}`,
  title,
  type: 'Album',
  year: 1994,
  coverUrl: null,
  artistMbid: `mbid-${artistName}`,
  artistName,
  status: { kind: 'available' },
});

async function render() {
  try {
    localStorage.removeItem('offbeat.tag.hideLibrary');
  } catch {
    // no storage in this environment
  }
  TestBed.configureTestingModule({
    imports: [TagPage],
    providers: [provideRouter([]), provideHttpClient(), provideHttpClientTesting()],
  });
  const fixture = TestBed.createComponent(TagPage);
  fixture.componentRef.setInput('tag', 'Pop Punk');
  fixture.detectChanges();
  const http = TestBed.inject(HttpTestingController);
  const settle = async () => {
    await new Promise((resolve) => setTimeout(resolve));
    await fixture.whenStable();
    fixture.detectChanges();
  };
  return { fixture, http, settle, el: fixture.nativeElement as HTMLElement };
}

describe('TagPage', () => {
  it('hides library artists by default, marks recommendations, and can show everything', async () => {
    const { fixture, http, settle, el } = await render();
    http.expectOne('api/v1/tags/Pop%20Punk').flush(DATA);
    await settle();
    http.expectOne('api/v1/tags/Pop%20Punk/albums').flush({ albums: [] });
    await settle();
    const names = () => [...el.querySelectorAll('.artist .name')].map((n) => n.textContent?.trim());

    expect(el.querySelector('h1')?.textContent).toBe('Pop Punk');
    expect(names()).toEqual(['Green Day', 'Weezer']);
    expect([...el.querySelectorAll('.artist .note')].map((n) => n.textContent?.trim())).toEqual(['Recommended']);

    el.querySelector<HTMLButtonElement>('[role="switch"]')!.click();
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    expect(names()).toEqual(['Green Day', 'Weezer', 'The Offspring']);
    expect(el.querySelector('.tags .tag')?.textContent?.trim()).toBe('Punk Rock');
  });

  it('says it is loading, shows the artists before the albums, then fills the albums in', async () => {
    const { http, settle, el } = await render();
    expect(el.querySelector('[aria-busy="true"]')?.textContent).toContain('Finding the best-known Pop Punk artists');

    http.expectOne('api/v1/tags/Pop%20Punk').flush(DATA);
    await settle();
    expect([...el.querySelectorAll('.artist .name')].map((n) => n.textContent?.trim())).toEqual(['Green Day', 'Weezer']);
    expect(el.querySelector('[aria-label="Loading top albums"]')).not.toBeNull();
    expect(el.querySelectorAll('.album-ghost')).toHaveLength(6);

    http.expectOne('api/v1/tags/Pop%20Punk/albums').flush({ albums: [album('Dookie', 'Green Day'), album('Smash', 'The Offspring')] });
    await settle();
    expect(el.querySelector('[aria-label="Loading top albums"]')).toBeNull();
    // The Offspring is in the library, and library artists are hidden by default.
    expect([...el.querySelectorAll('.album .title')].map((n) => n.textContent?.trim())).toEqual(['Dookie']);
  });

  it('keeps the artists when the albums cannot load', async () => {
    const { http, settle, el } = await render();
    http.expectOne('api/v1/tags/Pop%20Punk').flush(DATA);
    await settle();
    http.expectOne('api/v1/tags/Pop%20Punk/albums').flush({ error: 'MusicBrainz is unavailable' }, { status: 502, statusText: 'Bad Gateway' });
    await settle();
    expect(el.querySelectorAll('.artist')).toHaveLength(2);
    expect(el.querySelector('[aria-busy="true"]')).toBeNull();
    expect(el.querySelector('[role="alert"]')).toBeNull();
  });
});
