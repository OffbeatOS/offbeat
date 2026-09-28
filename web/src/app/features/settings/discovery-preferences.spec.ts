import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import type { DiscoverPreferences, DiscoverStatus } from '@offbeat/shared';
import { DiscoveryPreferences, lastRefreshedLabel } from './discovery-preferences';

const prefs: DiscoverPreferences = {
  defaultMode: 'balanced',
  sections: [
    { id: 'picks', visible: true },
    { id: 'albums', visible: true },
    { id: 'tags', visible: true },
  ],
};

const idle: DiscoverStatus = {
  refreshing: false,
  progress: null,
  generatedAt: new Date().toISOString(),
  error: null,
  nextRefreshAt: new Date(2026, 8, 29, 4, 0).toISOString(),
};

async function settle(fixture: { whenStable(): Promise<unknown>; detectChanges(): void }) {
  await new Promise((resolve) => setTimeout(resolve));
  await fixture.whenStable();
  fixture.detectChanges();
}

async function render(status: DiscoverStatus = idle) {
  TestBed.configureTestingModule({
    imports: [DiscoveryPreferences],
    providers: [provideHttpClient(), provideHttpClientTesting()],
  });
  const http = TestBed.inject(HttpTestingController);
  const fixture = TestBed.createComponent(DiscoveryPreferences);
  fixture.detectChanges();
  http.expectOne('api/v1/discover/status').flush(status);
  http.expectOne('api/v1/discover/preferences').flush(prefs);
  await settle(fixture);
  const el = fixture.nativeElement as HTMLElement;
  const names = () => [...el.querySelectorAll('.section-row .label')].map((n) => n.textContent?.trim());
  const button = (label: string) => el.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)!;
  return { el, http, fixture, names, button };
}

describe('DiscoveryPreferences', () => {
  it('reorders with Move up and Move down, keeping focus on the moved row, and saves', async () => {
    const { el, http, fixture, names, button } = await render();
    expect(names()).toEqual(['Top Picks for You', 'Albums to Start With', 'Explore by Tag']);
    expect(button('Move Top Picks for You up').disabled).toBe(true);

    button('Move Explore by Tag up').focus();
    button('Move Explore by Tag up').click();
    await settle(fixture);
    expect(names()).toEqual(['Top Picks for You', 'Explore by Tag', 'Albums to Start With']);
    expect(el.querySelector('[role="status"]')?.textContent).toContain('Explore by Tag moved to position 2 of 3.');
    const save = http.expectOne('api/v1/discover/preferences');
    expect(save.request.method).toBe('PUT');
    expect(save.request.body.sections.map((s: { id: string }) => s.id)).toEqual(['picks', 'tags', 'albums']);
    save.flush(save.request.body);
    await settle(fixture);

    // Again: now at the top, where Move up is disabled, so focus goes to Move down.
    button('Move Explore by Tag up').click();
    await settle(fixture);
    http.expectOne('api/v1/discover/preferences').flush({ ...prefs, sections: [prefs.sections[2], prefs.sections[0], prefs.sections[1]] });
    await settle(fixture);
    expect(names()[0]).toBe('Explore by Tag');
    expect(document.activeElement?.getAttribute('aria-label')).toBe('Move Explore by Tag down');
    http.verify();
  });

  it('hides a section with its switch, and sets the default mode', async () => {
    const { el, http, fixture, button } = await render();
    button('Show Albums to Start With').click();
    await settle(fixture);
    const hide = http.expectOne('api/v1/discover/preferences');
    expect(hide.request.body.sections[1]).toEqual({ id: 'albums', visible: false });
    hide.flush(hide.request.body);
    await settle(fixture);
    expect(button('Show Albums to Start With').getAttribute('aria-checked')).toBe('false');

    [...el.querySelectorAll<HTMLButtonElement>('.modes button')].find((b) => b.textContent?.trim() === 'Deeper')!.click();
    await settle(fixture);
    const mode = http.expectOne('api/v1/discover/preferences');
    expect(mode.request.body.defaultMode).toBe('deeper');
    mode.flush(mode.request.body);
    http.verify();
  });

  it('disables Refresh Now while a refresh runs and shows how far along it is', async () => {
    const { el, http, fixture } = await render();
    const refresh = () => el.querySelector<HTMLButtonElement>('.refresh-now')!;
    expect(refresh().disabled).toBe(false);
    expect(el.textContent).toContain('Daily at');

    refresh().click();
    await settle(fixture);
    expect(refresh().disabled).toBe(true);
    http.expectOne('api/v1/discover/refresh').flush({ refreshing: true }, { status: 202, statusText: 'Accepted' });
    await settle(fixture);
    http.expectOne('api/v1/discover/status').flush({ ...idle, refreshing: true, progress: { step: 2, steps: 4, label: 'Finding similar artists' } });
    await settle(fixture);
    expect(refresh().disabled).toBe(true);
    expect(refresh().textContent).toContain('Refreshing');
    expect(el.textContent).toContain('Step 2 of 4: Finding similar artists');
    expect(el.querySelector('.bar')).not.toBeNull();
    TestBed.resetTestingModule(); // stops the poll
  });
});

describe('lastRefreshedLabel', () => {
  it('says when, like the mockup', () => {
    const now = new Date(2026, 8, 27, 20, 0);
    expect(lastRefreshedLabel(new Date(2026, 8, 27, 4, 2).toISOString(), now)).toMatch(/^today at 4:02/);
    expect(lastRefreshedLabel(new Date(2026, 8, 26, 4, 2).toISOString(), now)).toMatch(/^yesterday at 4:02/);
    expect(lastRefreshedLabel(new Date(2026, 8, 20, 4, 2).toISOString(), now)).toMatch(/^on Sep 20 at 4:02/);
  });
});
