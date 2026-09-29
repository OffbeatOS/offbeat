import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import type { AlbumDetail, Track } from '@offbeat/shared';
import { Player } from '../../core/player';
import { QueueList } from './queue-list';

const track = (n: number): Track => ({
  position: String(n),
  title: `Track ${n}`,
  durationMs: 187_000,
  hasFile: true,
  trackFileId: 100 + n,
  mimeType: 'audio/flac',
});

const UNTRUE: AlbumDetail = {
  mbid: 'rg-untrue',
  title: 'Untrue',
  type: 'Album',
  year: 2007,
  coverUrl: null,
  artistMbid: 'a-burial',
  artistName: 'Burial',
  status: { kind: 'in-library' },
  artistInLibrary: true,
  monitored: true,
  trackFileCount: 4,
  trackCount: 4,
  genres: [],
  tracks: [1, 2, 3, 4].map(track),
  more: [],
};

describe('QueueList', () => {
  beforeEach(() => {
    TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting()] });
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
    vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined);
    vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => undefined);
  });

  afterEach(() => {
    TestBed.inject(Player).stop();
    vi.restoreAllMocks();
  });

  function render() {
    const player = TestBed.inject(Player);
    player.playAlbum(UNTRUE);
    const fixture = TestBed.createComponent(QueueList);
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    const titles = () => [...el.querySelectorAll('li .title')].map((t) => t.textContent?.trim());
    return { player, fixture, el, titles };
  }

  it('shows what is playing, "Next from" the album, and each track\'s length', () => {
    const { el, titles } = render();
    expect(el.querySelector('.current .title')?.textContent).toBe('Track 1');
    expect([...el.querySelectorAll('.label')].map((l) => l.textContent)).toEqual(['Now Playing', 'Next from Untrue']);
    expect(titles()).toEqual(['Track 2', 'Track 3', 'Track 4']);
    expect(el.querySelector('li .time')?.textContent).toBe('3:07');
  });

  it('reorders from the keyboard with the arrow keys on a handle, and says where it went', async () => {
    const { fixture, el, titles } = render();
    const handle = () => el.querySelector<HTMLButtonElement>('li .handle')!;
    expect(handle().getAttribute('aria-label')).toBe('Move Track 2, 1 of 3. Use the up and down arrow keys.');

    handle().dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    fixture.detectChanges();
    expect(titles()).toEqual(['Track 3', 'Track 2', 'Track 4']);
    expect(el.querySelector('[role="status"]')?.textContent).toBe('Track 2 moved to position 2 of 3.');

    // Up from the top does nothing.
    handle().dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
    fixture.detectChanges();
    expect(titles()).toEqual(['Track 3', 'Track 2', 'Track 4']);
  });

  it('plays a queued track when chosen', () => {
    const { player, fixture, el } = render();
    el.querySelectorAll<HTMLButtonElement>('li .play')[1]!.click();
    fixture.detectChanges();
    expect(player.current()?.title).toBe('Track 3');
  });
});
