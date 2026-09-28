import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import type { TagArtist, TagPage as TagPageData } from '@offbeat/shared';
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
  albums: [],
  related: ['Punk Rock'],
};

describe('TagPage', () => {
  it('hides library artists by default, marks recommendations, and can show everything', async () => {
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
    TestBed.inject(HttpTestingController).expectOne('api/v1/tags/Pop%20Punk').flush(DATA);
    await new Promise((resolve) => setTimeout(resolve));
    await fixture.whenStable();
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
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
});
