import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import type { MusicFilesCheck, MusicFilesView } from '@offbeat/shared';
import { MusicFiles } from './music-files';

const UNMAPPED: MusicFilesView = { folders: [{ lidarrPath: '/music', offbeatPath: '/music', mapped: false }], lastCheck: null, ffmpeg: '9.0.2' };

async function render() {
  TestBed.configureTestingModule({ imports: [MusicFiles], providers: [provideHttpClient(), provideHttpClientTesting()] });
  const fixture = TestBed.createComponent(MusicFiles);
  fixture.detectChanges();
  const http = TestBed.inject(HttpTestingController);
  const settle = async () => {
    await new Promise((resolve) => setTimeout(resolve));
    await fixture.whenStable();
    fixture.detectChanges();
  };
  return { http, settle, el: fixture.nativeElement as HTMLElement };
}

describe('MusicFiles settings', () => {
  it('saves where Offbeat reads each folder, then checks, and says what is wrong', async () => {
    const { http, settle, el } = await render();
    http.expectOne('api/v1/settings/music-files').flush(UNMAPPED);
    await settle();

    const input = el.querySelector<HTMLInputElement>('input')!;
    expect(input.placeholder).toBe('/music');
    expect(input.value).toBe('');
    input.value = '/mnt/user/music';
    input.dispatchEvent(new Event('input'));
    el.querySelector<HTMLButtonElement>('.btn-primary')!.click();
    await settle();

    const save = http.expectOne({ method: 'PUT', url: 'api/v1/settings/music-files' });
    expect(save.request.body).toEqual({ folders: [{ lidarrPath: '/music', offbeatPath: '/mnt/user/music' }] });
    const mapped: MusicFilesView = { folders: [{ lidarrPath: '/music', offbeatPath: '/mnt/user/music', mapped: true }], lastCheck: null, ffmpeg: '9.0.2' };
    save.flush(mapped);
    await settle();

    const check: MusicFilesCheck = {
      at: new Date().toISOString(),
      ok: false,
      folders: [{ lidarrPath: '/music', offbeatPath: '/mnt/user/music', readable: true, reason: null }],
      files: {
        checked: 3,
        readable: 2,
        problems: [{ lidarrPath: '/music/NOFX/03.flac', offbeatPath: '/mnt/user/music/NOFX/03.flac', reason: 'Not found.' }],
      },
    };
    http.expectOne({ method: 'POST', url: 'api/v1/settings/music-files/check' }).flush(check);
    await settle();
    http.expectOne('api/v1/settings/music-files').flush({ ...mapped, lastCheck: check });
    await settle();

    expect(el.querySelector('.summary .what')?.textContent).toContain('Offbeat could read 2 of 3 files');
    expect(el.querySelector('li .path')?.textContent).toBe('/mnt/user/music/NOFX/03.flac');
    expect(el.querySelector('li .reason')?.textContent).toBe('Not found.');
    expect(el.querySelector<HTMLInputElement>('input')!.value).toBe('/mnt/user/music');
  });

  it('shows a server refusal next to the buttons', async () => {
    const { http, settle, el } = await render();
    http.expectOne('api/v1/settings/music-files').flush(UNMAPPED);
    await settle();
    el.querySelector<HTMLButtonElement>('.btn-primary')!.click();
    await settle();
    http
      .expectOne({ method: 'PUT', url: 'api/v1/settings/music-files' })
      .flush({ error: 'Bad Request', message: 'music is not a full path' }, { status: 400, statusText: 'Bad Request' });
    await settle();
    expect(el.querySelector('[role="alert"]')?.textContent).toContain('not a full path');
  });
});
