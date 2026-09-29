import { Injectable, computed, inject, signal } from '@angular/core';
import type { AlbumDetail, PlayedTrack, RecordPlayRequest } from '@offbeat/shared';
import { Api } from './api';

/** One entry in the queue. `key` is unique per entry, so the same track can be queued twice. */
export interface QueueTrack {
  key: string;
  trackFileId: number;
  mimeType: string;
  title: string;
  artistName: string;
  artistMbid: string;
  albumTitle: string;
  albumMbid: string;
  coverUrl: string | null;
  durationMs: number | null;
}

export type Repeat = 'off' | 'all' | 'one';
export type QueueSection = 'added' | 'upNext';

const VOLUME_KEY = 'offbeat.player.volume';
/** Previous restarts the track instead of going back once this far in (seconds). */
const RESTART_AFTER = 3;
/** A track that "ends" more than this short of its length was cut off (a network hiccup), not finished. */
const CUT_SHORT = 3;
/** How many times one track picks up again after being cut off before the player moves on. */
const MAX_RESUMES = 2;
/** A play counts after half the track or 4 minutes of listening, whichever comes first (as ListenBrainz and Last.fm count). */
const PLAY_AFTER_MAX = 240;
/** Tracks shorter than this never count as plays. */
const PLAY_MIN_LENGTH = 30;
/** A failed play report is tried once more after this long. */
const REPORT_RETRY_MS = 15_000;

/** Seconds of listening before a track of this length counts as played. */
export function playThreshold(durationSeconds: number): number {
  return durationSeconds >= PLAY_MIN_LENGTH ? Math.min(durationSeconds / 2, PLAY_AFTER_MAX) : Infinity;
}
let nextKey = 0;

/** A play from History, as a queue entry. */
export function playedQueueEntry(played: PlayedTrack): QueueTrack {
  return {
    key: `q${++nextKey}`,
    trackFileId: played.trackFileId,
    mimeType: played.mimeType,
    title: played.title,
    artistName: played.artistName,
    artistMbid: played.artistMbid ?? '',
    albumTitle: played.albumTitle,
    albumMbid: played.albumMbid ?? '',
    coverUrl: played.coverUrl,
    durationMs: played.durationMs,
  };
}

/** The tracks of an album that have files, as queue entries. */
export function albumQueue(album: AlbumDetail): QueueTrack[] {
  return album.tracks.flatMap((track) =>
    track.trackFileId && track.mimeType
      ? [
          {
            key: `q${++nextKey}`,
            trackFileId: track.trackFileId,
            mimeType: track.mimeType,
            title: track.title,
            artistName: album.artistName,
            artistMbid: album.artistMbid,
            albumTitle: album.title,
            albumMbid: album.mbid,
            coverUrl: album.coverUrl,
            durationMs: track.durationMs,
          },
        ]
      : [],
  );
}

/**
 * The player: one audio element for the whole app, so playback survives
 * page navigation. The queue has the track playing, "Added by you" (played
 * next, in order), and the rest of what was started ("Next from" an album).
 * The browser plays what it can directly; anything else streams as MP3 from
 * ffmpeg, and seeking in that asks the server to start again from there.
 */
@Injectable({ providedIn: 'root' })
export class Player {
  private readonly api = inject(Api);
  readonly current = signal<QueueTrack | null>(null);
  readonly added = signal<readonly QueueTrack[]>([]);
  readonly upNext = signal<readonly QueueTrack[]>([]);
  /** What upNext comes from, for "Next from Untrue" and "Playing from Untrue". */
  readonly context = signal<{ title: string; albumMbid: string } | null>(null);
  /** Played this session, most recent first. */
  readonly history = signal<readonly QueueTrack[]>([]);

  readonly playing = signal(false);
  readonly buffering = signal(false);
  /** Seconds into the track. */
  readonly position = signal(0);
  readonly volume = signal(readVolume());
  readonly shuffle = signal(false);
  readonly repeat = signal<Repeat>('off');
  readonly error = signal('');
  /** Whether the current track is streaming transcoded (seeking restarts the stream). */
  readonly transcoding = signal(false);

  /** The queue drawer (desktop) and the Now Playing view. */
  readonly queueOpen = signal(false);
  readonly nowPlayingOpen = signal(false);

  /** Something has been queued: the bottom bar is the player. */
  readonly active = computed(() => !!this.current());
  /** Seconds, from the file once the browser knows it, otherwise from Lidarr. */
  readonly duration = computed(() => {
    const known = this.mediaDuration();
    if (known) return known;
    return (this.current()?.durationMs ?? 0) / 1000;
  });

  private readonly mediaDuration = signal(0);
  /** The context in its original order, to undo shuffle. */
  private contextOrder: QueueTrack[] = [];
  /** For a transcoded stream: where it started, in seconds. */
  private offset = 0;
  private audio: HTMLAudioElement | null = null;
  private triedTranscode = false;
  private resumes = 0;
  /** Seconds actually listened to of this playthrough (seeking forward does not count). */
  private listened = 0;
  /** The animation frame keeping the position smooth while playing. */
  private frame = 0;
  private reported = false;
  private startedAt = new Date();
  /** Counts plays reported this session, so History knows to look again. */
  readonly playsReported = signal(0);

  /** Starts an album (or its tracks from `startAt`), replacing what was queued from before. */
  playAlbum(album: AlbumDetail, { startAt = 0, shuffle = false }: { startAt?: number; shuffle?: boolean } = {}) {
    const tracks = albumQueue(album);
    if (!tracks.length) return;
    this.contextOrder = tracks;
    this.context.set({ title: album.title, albumMbid: album.mbid });
    this.shuffle.set(shuffle);
    const first = shuffle ? Math.floor(Math.random() * tracks.length) : Math.min(Math.max(startAt, 0), tracks.length - 1);
    const rest = tracks.filter((_, i) => i !== first);
    this.upNext.set(shuffle ? shuffled(rest) : tracks.slice(first + 1));
    this.load(tracks[first]!, true);
  }

  /** The album's track with this file, from where it is on the album. */
  playTrackOf(album: AlbumDetail, trackFileId: number) {
    const index = albumQueue(album).findIndex((t) => t.trackFileId === trackFileId);
    if (index >= 0) this.playAlbum(album, { startAt: index });
  }

  /** Queues tracks right after what is playing, ahead of anything already added. */
  playNext(tracks: QueueTrack[]) {
    if (!this.current()) return this.startFrom(tracks);
    this.added.update((added) => [...fresh(tracks), ...added]);
  }

  /** Queues tracks after everything already added. */
  addToQueue(tracks: QueueTrack[]) {
    if (!this.current()) return this.startFrom(tracks);
    this.added.update((added) => [...added, ...fresh(tracks)]);
  }

  toggle() {
    if (this.playing()) this.pause();
    else this.resume();
  }

  resume() {
    if (!this.current() || !this.audio) return;
    this.error.set('');
    void this.audio.play().catch(() => this.playing.set(false));
  }

  pause() {
    this.audio?.pause();
  }

  next() {
    const [fromAdded, ...restAdded] = this.added();
    if (fromAdded) {
      this.added.set(restAdded);
      return this.load(fromAdded, true);
    }
    const [fromContext, ...restContext] = this.upNext();
    if (fromContext) {
      this.upNext.set(restContext);
      return this.load(fromContext, true);
    }
    if (this.repeat() === 'all' && this.contextOrder.length) {
      const again = this.shuffle() ? shuffled(this.contextOrder) : this.contextOrder;
      this.upNext.set(fresh(again.slice(1)));
      return this.load(fresh([again[0]!])[0]!, true);
    }
    // The end of the queue: stop at the start of the last track.
    this.pause();
    this.seek(0);
  }

  previous() {
    if (this.position() > RESTART_AFTER || !this.history().length) return this.seek(0);
    const [last, ...older] = this.history();
    const current = this.current();
    if (current) this.upNext.update((next) => [current, ...next]);
    this.history.set(older);
    this.load(last!, true, { remember: false });
  }

  seek(seconds: number) {
    const audio = this.audio;
    if (!audio || !this.current()) return;
    const target = Math.min(Math.max(seconds, 0), this.duration() || seconds);
    if (this.transcoding()) {
      // A transcoded stream has no byte ranges: ask for a new one from there.
      this.offset = target;
      this.position.set(target);
      const wasPlaying = this.playing();
      audio.src = this.streamUrl(this.current()!, target);
      if (wasPlaying) void audio.play().catch(() => undefined);
      return;
    }
    audio.currentTime = target;
    this.position.set(target);
  }

  setVolume(volume: number) {
    const value = Math.min(Math.max(volume, 0), 1);
    this.volume.set(value);
    if (this.audio) this.audio.volume = value;
    try {
      localStorage.setItem(VOLUME_KEY, String(value));
    } catch {
      // storage unavailable: the volume lasts for this visit
    }
  }

  toggleShuffle() {
    const on = !this.shuffle();
    this.shuffle.set(on);
    if (on) {
      this.upNext.update((next) => shuffled(next));
      return;
    }
    // Back to album order, after the track playing.
    const current = this.current();
    const at = this.contextOrder.findIndex((t) => t.trackFileId === current?.trackFileId);
    const waiting = new Set(this.upNext().map((t) => t.trackFileId));
    this.upNext.set(this.contextOrder.slice(at + 1).filter((t) => waiting.has(t.trackFileId)));
  }

  cycleRepeat() {
    this.repeat.update((r) => (r === 'off' ? 'all' : r === 'all' ? 'one' : 'off'));
  }

  /** Plays a queued entry now, skipping what was before it in its section. */
  jumpTo(section: QueueSection, index: number) {
    const list = section === 'added' ? this.added() : this.upNext();
    const track = list[index];
    if (!track) return;
    if (section === 'added') this.added.set(list.slice(index + 1));
    else {
      this.added.set([]);
      this.upNext.set(list.slice(index + 1));
    }
    this.load(track, true);
  }

  move(section: QueueSection, from: number, to: number) {
    const update = (list: readonly QueueTrack[]) => {
      if (from < 0 || from >= list.length || to < 0 || to >= list.length || from === to) return list;
      const copy = [...list];
      const [item] = copy.splice(from, 1);
      copy.splice(to, 0, item!);
      return copy;
    };
    if (section === 'added') this.added.update(update);
    else this.upNext.update(update);
  }

  remove(section: QueueSection, index: number) {
    const drop = (list: readonly QueueTrack[]) => list.filter((_, i) => i !== index);
    if (section === 'added') this.added.update(drop);
    else this.upNext.update(drop);
  }

  /** Clears what is queued after the track playing. */
  clearQueue() {
    this.added.set([]);
    this.upNext.set([]);
  }

  /** Stops and forgets everything, for signing out. */
  stop() {
    if (this.audio) {
      this.audio.pause();
      this.audio.removeAttribute('src');
      this.audio.load();
    }
    this.current.set(null);
    this.clearQueue();
    this.history.set([]);
    this.context.set(null);
    this.contextOrder = [];
    this.playing.set(false);
    this.position.set(0);
    this.queueOpen.set(false);
    this.nowPlayingOpen.set(false);
    if ('mediaSession' in navigator) {
      navigator.mediaSession.metadata = null;
      navigator.mediaSession.playbackState = 'none';
    }
  }

  /** Whether this album is the one playing from (for its Play/Pause button). */
  isPlayingFrom(albumMbid: string): boolean {
    return this.current()?.albumMbid === albumMbid;
  }

  private startFrom(tracks: QueueTrack[]) {
    const [first, ...rest] = fresh(tracks);
    if (!first) return;
    this.contextOrder = [first, ...rest];
    this.context.set({ title: first.albumTitle, albumMbid: first.albumMbid });
    this.upNext.set(rest);
    this.load(first, true);
  }

  private load(track: QueueTrack, autoplay: boolean, { remember = true } = {}) {
    const audio = this.element();
    const previous = this.current();
    if (previous && remember && previous.key !== track.key) this.history.update((h) => [previous, ...h].slice(0, 100));
    this.current.set(track);
    this.error.set('');
    this.offset = 0;
    this.position.set(0);
    this.mediaDuration.set(0);
    this.triedTranscode = false;
    this.resumes = 0;
    this.newPlaythrough();
    this.transcoding.set(!canPlay(audio, track.mimeType));
    audio.src = this.streamUrl(track, 0);
    this.updateMediaSession(track);
    if (autoplay) void audio.play().catch(() => this.playing.set(false));
  }

  private streamUrl(track: QueueTrack, from: number): string {
    const base = `api/v1/stream/${track.trackFileId}`;
    return this.transcoding() ? `${base}?transcode=mp3&t=${from.toFixed(1)}` : base;
  }

  /** The one audio element, made on first use (so tests and server rendering never need one). */
  private element(): HTMLAudioElement {
    if (this.audio) return this.audio;
    const audio = new Audio();
    audio.preload = 'auto';
    audio.volume = this.volume();
    audio.addEventListener('playing', () => {
      this.playing.set(true);
      this.buffering.set(false);
      this.setPlaybackState('playing');
      this.followFrames();
    });
    audio.addEventListener('pause', () => {
      this.playing.set(false);
      this.setPlaybackState('paused');
      cancelAnimationFrame(this.frame);
    });
    audio.addEventListener('waiting', () => this.buffering.set(true));
    audio.addEventListener('canplay', () => this.buffering.set(false));
    // The browser reports time a few times a second, which makes the bar step; followFrames
    // smooths it while visible. This still runs in the background and on a locked phone.
    audio.addEventListener('timeupdate', () => {
      const position = this.offset + audio.currentTime;
      this.countListening(position);
      this.position.set(position);
      this.updatePositionState();
    });
    audio.addEventListener('durationchange', () => {
      // A transcoded stream's duration is only what is left from the offset, if known at all.
      if (!this.transcoding() && Number.isFinite(audio.duration)) this.mediaDuration.set(audio.duration);
    });
    audio.addEventListener('ended', () => {
      const duration = this.duration();
      if (duration && this.position() < duration - CUT_SHORT && this.resumes < MAX_RESUMES) {
        // The stream stopped early: pick up where it left off rather than skip the rest.
        this.resumes++;
        this.resumeAt(this.position());
        return;
      }
      if (this.repeat() === 'one') {
        this.newPlaythrough();
        this.seek(0);
        void audio.play().catch(() => undefined);
      } else {
        this.next();
      }
    });
    audio.addEventListener('error', () => void this.failed());
    this.audio = audio;
    this.registerMediaSession();
    return audio;
  }

  /** Reads the position every frame while playing, so the progress bar moves smoothly. */
  private followFrames() {
    cancelAnimationFrame(this.frame);
    const step = () => {
      const audio = this.audio;
      if (!audio || audio.paused) return;
      const position = this.offset + audio.currentTime;
      this.countListening(position);
      this.position.set(position);
      this.frame = requestAnimationFrame(step);
    };
    this.frame = requestAnimationFrame(step);
  }

  private newPlaythrough() {
    this.listened = 0;
    this.reported = false;
    this.startedAt = new Date();
  }

  /** Adds the time played since the last update, and reports the play once it is long enough. */
  private countListening(position: number) {
    const step = position - this.position();
    // Playback moves a fraction of a second between updates; a seek jumps further.
    if (this.playing() && step > 0 && step < 2) this.listened += step;
    const track = this.current();
    if (track && !this.reported && this.listened >= playThreshold(this.duration())) {
      this.reported = true;
      void this.report({ trackFileId: track.trackFileId, playedAt: this.startedAt.toISOString() });
    }
  }

  private async report(play: RecordPlayRequest, retry = true): Promise<void> {
    try {
      await this.api.post('plays', play);
      this.playsReported.update((n) => n + 1);
    } catch {
      // Offline for a moment, or Offbeat restarting: one more try. The server ignores a repeat.
      if (retry) setTimeout(() => void this.report(play, false), REPORT_RETRY_MS);
    }
  }

  /** Reloads the stream and carries on from `seconds`. */
  private resumeAt(seconds: number) {
    const audio = this.audio;
    const track = this.current();
    if (!audio || !track) return;
    if (this.transcoding()) {
      this.offset = seconds;
      audio.src = this.streamUrl(track, seconds);
    } else {
      audio.src = this.streamUrl(track, 0);
      audio.addEventListener('loadedmetadata', () => (audio.currentTime = seconds), { once: true });
    }
    void audio.play().catch(() => undefined);
  }

  /** The stream would not play: try transcoding once, then say why. */
  private async failed() {
    const track = this.current();
    const audio = this.audio;
    if (!track || !audio || !audio.getAttribute('src')) return;
    if (!this.transcoding() && !this.triedTranscode && audio.error?.code === MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED) {
      // The browser said it might play this, then could not.
      this.triedTranscode = true;
      this.transcoding.set(true);
      audio.src = this.streamUrl(track, this.position());
      this.offset = this.position();
      void audio.play().catch(() => undefined);
      return;
    }
    this.playing.set(false);
    this.error.set(await this.explain(track));
  }

  /** Asks the server why a stream failed, since the audio element cannot tell. */
  private async explain(track: QueueTrack): Promise<string> {
    try {
      // One byte of the file itself: never a transcode, which would start ffmpeg just to answer.
      const response = await fetch(`api/v1/stream/${track.trackFileId}`, { headers: { Range: 'bytes=0-0' } });
      if (response.ok) return 'This track could not be played';
      const body = (await response.json().catch(() => null)) as { message?: string } | null;
      if (response.status === 401) return 'You were signed out. Sign in again to keep listening.';
      return body?.message ?? 'This track could not be played';
    } catch {
      return 'Offbeat could not be reached';
    }
  }

  private registerMediaSession() {
    if (!('mediaSession' in navigator)) return;
    const session = navigator.mediaSession;
    const handlers: [MediaSessionAction, MediaSessionActionHandler][] = [
      ['play', () => this.resume()],
      ['pause', () => this.pause()],
      ['previoustrack', () => this.previous()],
      ['nexttrack', () => this.next()],
      ['seekto', (details) => details.seekTime !== undefined && this.seek(details.seekTime)],
      ['seekbackward', (details) => this.seek(this.position() - (details.seekOffset ?? 10))],
      ['seekforward', (details) => this.seek(this.position() + (details.seekOffset ?? 10))],
    ];
    for (const [action, handler] of handlers) {
      try {
        session.setActionHandler(action, handler);
      } catch {
        // this browser does not offer that action
      }
    }
  }

  private updateMediaSession(track: QueueTrack) {
    if (!('mediaSession' in navigator) || typeof MediaMetadata === 'undefined') return;
    const artwork = track.coverUrl ? [{ src: new URL(track.coverUrl, document.baseURI).href, sizes: '600x600' }] : [];
    navigator.mediaSession.metadata = new MediaMetadata({ title: track.title, artist: track.artistName, album: track.albumTitle, artwork });
  }

  /** Lock screens and media keys show play or pause from this. */
  private setPlaybackState(state: MediaSessionPlaybackState) {
    if ('mediaSession' in navigator) navigator.mediaSession.playbackState = state;
  }

  private updatePositionState() {
    if (!('mediaSession' in navigator) || !navigator.mediaSession.setPositionState) return;
    const duration = this.duration();
    if (!duration) return;
    try {
      navigator.mediaSession.setPositionState({ duration, position: Math.min(this.position(), duration), playbackRate: 1 });
    } catch {
      // position past the duration while a stream catches up
    }
  }
}

/** Whether the browser says it can play this type directly ("maybe" counts: FLAC reports that). */
function canPlay(audio: HTMLAudioElement, mimeType: string): boolean {
  return audio.canPlayType(mimeType) !== '';
}

/** New keys, so entries queued again are distinct from the ones already there. */
function fresh(tracks: readonly QueueTrack[]): QueueTrack[] {
  return tracks.map((t) => ({ ...t, key: `q${++nextKey}` }));
}

function shuffled<T>(list: readonly T[]): T[] {
  const copy = [...list];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j]!, copy[i]!];
  }
  return copy;
}

function readVolume(): number {
  try {
    const saved = Number(localStorage.getItem(VOLUME_KEY));
    return localStorage.getItem(VOLUME_KEY) !== null && Number.isFinite(saved) ? Math.min(Math.max(saved, 0), 1) : 1;
  } catch {
    return 1;
  }
}
