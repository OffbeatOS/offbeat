import { TestBed } from '@angular/core/testing';
import type { AlbumDetail, Track } from '@offbeat/shared';
import { Player } from './player';

const track = (n: number, extra: Partial<Track> = {}): Track => ({
  position: String(n),
  title: `Track ${n}`,
  durationMs: 200_000,
  hasFile: true,
  trackFileId: 100 + n,
  mimeType: 'audio/flac',
  ...extra,
});

const album = (tracks: Track[], extra: Partial<AlbumDetail> = {}): AlbumDetail => ({
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
  trackFileCount: tracks.length,
  trackCount: tracks.length,
  genres: [],
  tracks,
  more: [],
  ...extra,
});

describe('Player', () => {
  let player: Player;
  let canPlay: string;

  beforeEach(() => {
    canPlay = 'maybe';
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
    vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined);
    vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => undefined);
    vi.spyOn(HTMLMediaElement.prototype, 'canPlayType').mockImplementation(() => canPlay as CanPlayTypeResult);
    player = TestBed.inject(Player);
  });

  afterEach(() => {
    player.stop();
    vi.restoreAllMocks();
  });

  const titles = () => ({
    current: player.current()?.title ?? null,
    added: player.added().map((t) => t.title),
    upNext: player.upNext().map((t) => t.title),
  });

  it('plays an album from a track, queueing the rest and skipping tracks without files', () => {
    player.playAlbum(album([track(1), track(2, { trackFileId: null, mimeType: null }), track(3), track(4)]), { startAt: 1 });
    expect(titles()).toEqual({ current: 'Track 3', added: [], upNext: ['Track 4'] });
    expect(player.context()).toEqual({ title: 'Untrue', albumMbid: 'rg-untrue' });
    expect(player.active()).toBe(true);
    expect(player.duration()).toBe(200);
  });

  it('plays what you added before the rest of the album, in the order you asked', () => {
    const untrue = album([track(1), track(2), track(3)]);
    player.playAlbum(untrue);
    const [two, three] = player.upNext();
    player.addToQueue([three!]);
    player.playNext([two!]);
    expect(titles().added).toEqual(['Track 2', 'Track 3']);

    player.next();
    expect(titles()).toEqual({ current: 'Track 2', added: ['Track 3'], upNext: ['Track 2', 'Track 3'] });
    player.next();
    player.next();
    expect(titles().current).toBe('Track 2');
    expect(player.history().map((t) => t.title)).toEqual(['Track 3', 'Track 2', 'Track 1']);
  });

  it('goes back a track near the start, and to the start of the track further in', () => {
    player.playAlbum(album([track(1), track(2)]));
    player.next();
    player.position.set(30);
    player.previous();
    expect(titles().current).toBe('Track 2');
    expect(player.position()).toBe(0);

    player.previous();
    expect(titles()).toEqual({ current: 'Track 1', added: [], upNext: ['Track 2'] });
  });

  it('shuffles what is left, and puts it back in album order', () => {
    player.playAlbum(album([1, 2, 3, 4, 5, 6, 7, 8].map((n) => track(n))));
    player.toggleShuffle();
    expect([...titles().upNext].sort()).toEqual(['Track 2', 'Track 3', 'Track 4', 'Track 5', 'Track 6', 'Track 7', 'Track 8']);
    player.toggleShuffle();
    expect(titles().upNext).toEqual(['Track 2', 'Track 3', 'Track 4', 'Track 5', 'Track 6', 'Track 7', 'Track 8']);
  });

  it('starts over at the end with Repeat, and stops without it', () => {
    player.playAlbum(album([track(1), track(2)]));
    player.next();
    player.next();
    expect(titles().current).toBe('Track 2');
    expect(player.playing()).toBe(false);

    player.cycleRepeat();
    expect(player.repeat()).toBe('all');
    player.next();
    expect(titles()).toEqual({ current: 'Track 1', added: [], upNext: ['Track 2'] });
  });

  it('reorders, removes, jumps to, and clears queued tracks', () => {
    player.playAlbum(album([1, 2, 3, 4].map((n) => track(n))));
    player.move('upNext', 2, 0);
    expect(titles().upNext).toEqual(['Track 4', 'Track 2', 'Track 3']);
    player.remove('upNext', 1);
    expect(titles().upNext).toEqual(['Track 4', 'Track 3']);
    player.jumpTo('upNext', 1);
    expect(titles()).toEqual({ current: 'Track 3', added: [], upNext: [] });
    player.addToQueue([...player.history()]);
    player.clearQueue();
    expect(titles()).toEqual({ current: 'Track 3', added: [], upNext: [] });
  });

  it('plays formats the browser supports directly, and streams the rest as MP3, seeking by restarting the stream', () => {
    player.playAlbum(album([track(1)]));
    const audio = () => (player as unknown as { audio: HTMLAudioElement }).audio;
    expect(audio().getAttribute('src')).toBe('api/v1/stream/101');
    expect(player.transcoding()).toBe(false);

    canPlay = '';
    player.playAlbum(album([track(2, { mimeType: 'audio/x-ms-wma' })]));
    expect(player.transcoding()).toBe(true);
    expect(audio().getAttribute('src')).toBe('api/v1/stream/102?transcode=mp3&t=0.0');
    player.seek(95.5);
    expect(audio().getAttribute('src')).toBe('api/v1/stream/102?transcode=mp3&t=95.5');
    expect(player.position()).toBe(95.5);
  });

  it('picks a track up again when its stream stops early, instead of skipping the rest of it', () => {
    player.playAlbum(album([track(1), track(2)]));
    const audio = (player as unknown as { audio: HTMLAudioElement }).audio;
    player.position.set(30);
    audio.dispatchEvent(new Event('ended'));
    expect(player.current()?.title).toBe('Track 1');

    // Ended at the end: on to the next track.
    player.position.set(199);
    audio.dispatchEvent(new Event('ended'));
    expect(player.current()?.title).toBe('Track 2');
  });

  it('gives up picking a track up again after a couple of tries', () => {
    player.playAlbum(album([track(1), track(2)]));
    const audio = (player as unknown as { audio: HTMLAudioElement }).audio;
    for (let i = 0; i < 3; i++) {
      player.position.set(30);
      audio.dispatchEvent(new Event('ended'));
    }
    expect(player.current()?.title).toBe('Track 2');
  });

  it('forgets everything when stopped (signing out)', () => {
    player.playAlbum(album([track(1), track(2)]));
    player.nowPlayingOpen.set(true);
    player.stop();
    expect(player.active()).toBe(false);
    expect(titles()).toEqual({ current: null, added: [], upNext: [] });
    expect(player.nowPlayingOpen()).toBe(false);
  });
});
