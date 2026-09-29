import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import type { AccountView } from '@offbeat/shared';
import { ListenBrainzSubmit } from './listenbrainz-submit';

const ACCOUNT: AccountView = {
  username: 'sam',
  role: 'user',
  lastfmUsername: null,
  listenbrainzUsername: null,
  lastfmAvailable: false,
  listenbrainzSubmit: null,
};

function render(account: AccountView) {
  TestBed.configureTestingModule({ imports: [ListenBrainzSubmit], providers: [provideHttpClient(), provideHttpClientTesting()] });
  const fixture = TestBed.createComponent(ListenBrainzSubmit);
  fixture.componentRef.setInput('account', account);
  const changed: AccountView[] = [];
  fixture.componentInstance.changed.subscribe((a) => changed.push(a));
  fixture.detectChanges();
  const settle = async () => {
    await new Promise((resolve) => setTimeout(resolve));
    await fixture.whenStable();
    fixture.detectChanges();
  };
  return { fixture, settle, changed, http: TestBed.inject(HttpTestingController), el: fixture.nativeElement as HTMLElement };
}

describe('ListenBrainzSubmit', () => {
  it('sends the token to be checked, and hands back the account', async () => {
    const { el, http, settle, changed } = render(ACCOUNT);
    const input = el.querySelector<HTMLInputElement>('input')!;
    expect(input.type).toBe('password');
    input.value = ' 11111111-2222-4333-8444-555555555555 ';
    input.dispatchEvent(new Event('input'));
    await settle();
    el.querySelector<HTMLButtonElement>('.btn-primary')!.click();

    const request = http.expectOne({ method: 'PUT', url: 'api/v1/account/listenbrainz-token' });
    expect(request.request.body).toEqual({ token: '11111111-2222-4333-8444-555555555555' });
    const connected = { ...ACCOUNT, listenbrainzSubmit: { userName: 'sam_lb', lastSubmittedAt: null, pending: 0, error: null } };
    request.flush(connected);
    await settle();
    expect(changed).toEqual([connected]);
  });

  it('says why ListenBrainz refused a token', async () => {
    const { el, http, settle } = render(ACCOUNT);
    const input = el.querySelector<HTMLInputElement>('input')!;
    input.value = '11111111-2222-4333-8444-555555555555';
    input.dispatchEvent(new Event('input'));
    await settle();
    el.querySelector<HTMLButtonElement>('.btn-primary')!.click();
    http
      .expectOne('api/v1/account/listenbrainz-token')
      .flush({ error: 'Unprocessable Entity', message: 'ListenBrainz did not accept that token.' }, { status: 422, statusText: 'Unprocessable Entity' });
    await settle();
    expect(el.querySelector('[role="alert"]')?.textContent).toContain('did not accept that token');
  });

  it('shows where plays go, and what is waiting when sending fails', () => {
    const { el } = render({ ...ACCOUNT, listenbrainzSubmit: { userName: 'sam_lb', lastSubmittedAt: null, pending: 3, error: 'ListenBrainz did not take the listens (HTTP 503)' } });
    expect(el.querySelector('.what')?.textContent).toContain('as sam_lb');
    expect(el.querySelector('.problem')?.textContent).toBe('3 waiting: ListenBrainz did not take the listens (HTTP 503)');
    expect(el.querySelector('input')).toBeNull();
  });
});
