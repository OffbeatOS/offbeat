import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router, provideRouter, withComponentInputBinding } from '@angular/router';
import type { CurrentUser } from '@offbeat/shared';
import { App } from './app';
import { routes } from './app.routes';
import { safeReturnUrl } from './core/guards';
import { Session } from './core/session';

/** Session stand-in so routing can be tested without a server. */
function fakeSession(state: { needsAdmin?: boolean; user?: CurrentUser | null }) {
  return {
    user: signal(state.user ?? null),
    needsAdmin: signal(state.needsAdmin ?? false),
    unreachable: signal(false),
    ensureLoaded: () => Promise.resolve(),
  };
}

const admin: CurrentUser = { id: 1, username: 'admin', role: 'admin' };

async function boot(session: ReturnType<typeof fakeSession>, url: string) {
  TestBed.configureTestingModule({
    imports: [App],
    providers: [
      provideRouter(routes, withComponentInputBinding()),
      { provide: Session, useValue: session },
    ],
  });
  const fixture = TestBed.createComponent(App);
  const router = TestBed.inject(Router);
  await router.navigateByUrl(url);
  await fixture.whenStable();
  return { el: fixture.nativeElement as HTMLElement, router };
}

describe('routing', () => {
  it('sends everyone to onboarding before an admin exists', async () => {
    const { router, el } = await boot(fakeSession({ needsAdmin: true }), '/library');
    expect(router.url).toBe('/onboarding');
    expect(el.querySelector('h1')?.textContent).toBe('Create your account');
    expect(el.querySelector('ob-sidebar')).toBeNull();
  });

  it('asks signed-out visitors to sign in, remembering where they were going', async () => {
    const { router } = await boot(fakeSession({}), '/library');
    expect(router.url).toBe('/login?returnUrl=%2Flibrary');
  });

  it('keeps signed-in users out of onboarding and sign-in', async () => {
    const { router } = await boot(fakeSession({ user: admin }), '/onboarding');
    expect(router.url).toBe('/discover');
    await router.navigateByUrl('/login?returnUrl=%2Factivity');
    expect(router.url).toBe('/activity');
  });

  it('only follows in-app return URLs', () => {
    expect(safeReturnUrl('/library')).toBe('/library');
    expect(safeReturnUrl('//evil.example')).toBe('/discover');
    expect(safeReturnUrl('https://evil.example')).toBe('/discover');
    expect(safeReturnUrl(null)).toBe('/discover');
  });
});

describe('app shell', () => {
  it('renders the sidebar, content region, and bottom bar', async () => {
    const { el } = await boot(fakeSession({ user: admin }), '/discover');
    const labels = [...el.querySelectorAll('ob-sidebar ob-nav-item')].map((n) => n.textContent?.trim());
    expect(labels).toEqual(['Discover', 'Search', 'Library', 'Activity', 'Flows', 'Shows', 'Settings']);
    expect(el.querySelector('ob-shell-layout main router-outlet')).toBeTruthy();
    expect(el.querySelector('ob-bottom-bar')).toBeTruthy();
    expect(el.querySelector('main ob-bottom-bar')).toBeNull();
  });

  it('marks the current route active in the sidebar', async () => {
    const { el } = await boot(fakeSession({ user: admin }), '/library');
    const active = el.querySelector('ob-sidebar a.active');
    expect(active?.textContent?.trim()).toBe('Library');
    expect(active?.getAttribute('aria-current')).toBe('page');
    expect(el.querySelector('main h1')?.textContent).toBe('Library');
  });

  it('shows the signed-in account in settings', async () => {
    const { el } = await boot(fakeSession({ user: admin }), '/settings/account');
    expect(el.querySelector('ob-account-settings .name')?.textContent).toBe('admin');
    expect(el.querySelector('ob-settings-layout a.active')?.textContent?.trim()).toBe('Account');
  });
});
