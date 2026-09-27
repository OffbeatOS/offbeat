import { TestBed } from '@angular/core/testing';
import { provideRouter, Router, withComponentInputBinding } from '@angular/router';
import { App } from './app';
import { routes } from './app.routes';

describe('App shell', () => {
  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [App],
      providers: [provideRouter(routes, withComponentInputBinding())],
    }).compileComponents();
  });

  it('renders the sidebar, content region, and bottom bar', async () => {
    const fixture = TestBed.createComponent(App);
    await fixture.whenStable();
    const el = fixture.nativeElement as HTMLElement;

    const labels = [...el.querySelectorAll('ob-sidebar ob-nav-item')].map((n) =>
      n.textContent?.trim(),
    );
    expect(labels).toEqual([
      'Discover',
      'Search',
      'Library',
      'Activity',
      'Flows',
      'Shows',
      'Settings',
    ]);
    expect(el.querySelector('main router-outlet')).toBeTruthy();
    expect(el.querySelector('ob-bottom-bar')).toBeTruthy();
  });

  it('keeps the bottom bar outside the router outlet', async () => {
    const fixture = TestBed.createComponent(App);
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('main ob-bottom-bar')).toBeNull();
  });

  it('marks the current route active in the sidebar', async () => {
    const fixture = TestBed.createComponent(App);
    await TestBed.inject(Router).navigateByUrl('/library');
    await fixture.whenStable();
    const el = fixture.nativeElement as HTMLElement;

    const active = el.querySelector('ob-sidebar a.active');
    expect(active?.textContent?.trim()).toBe('Library');
    expect(active?.getAttribute('aria-current')).toBe('page');
    expect(el.querySelector('main h1')?.textContent).toBe('Library');
  });
});
