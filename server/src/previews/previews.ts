import type { ArtistPreview, PreviewTrack } from '@offbeat/shared';
import type { FastifyBaseLogger } from 'fastify';
import type { Db } from '../db/index.js';
import { normalizeName } from '../discovery/engine.js';
import { SourceCache } from '../discovery/source-cache.js';
import { type DeezerClient, DeezerError } from '../integrations/deezer/client.js';
import type { MusicBrainzClient } from '../integrations/musicbrainz/client.js';
import type { ImageUrls } from '../library/image-urls.js';

const DAY = 24 * 60 * 60 * 1000;
/** Which Deezer artist an MBID is (or that none is): artists rarely move. */
const MATCH_FOR_MS = 30 * DAY;
/** An artist's top tracks change slowly. */
const TOP_FOR_MS = DAY;
/** Deezer preview addresses expire after about 15 minutes; reuse one briefly (a player asks more than once). */
const AUDIO_URL_FOR_MS = 5 * 60_000;
const TOP_TRACKS = 5;
/** When top tracks have no previews, how many albums to look in. */
const ALBUMS_TO_TRY = 8;
/** Look at a few same-name artists at most. */
const CANDIDATES = 3;

/** An album title reduced for comparing across services: no edition notes, punctuation, or "The". */
export function titleKey(title: string): string {
  return normalizeName(title)
    .replace(/\s*[([].*?[)\]]\s*/g, ' ')
    .replace(/\s+-\s+(remaster|deluxe|live|single|ep|expanded|anniversary).*$/, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/** Only Deezer's preview servers, over https: the audio proxy fetches nothing else. */
export function isDeezerPreviewUrl(raw: string | null | undefined): raw is string {
  if (!raw) return false;
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' && !url.username && !url.password && (url.port === '' || url.port === '443') && url.hostname.endsWith('.dzcdn.net');
  } catch {
    return false;
  }
}

type CachedTrack = Omit<PreviewTrack, 'audioUrl' | 'coverUrl'> & { cover: string | null };

/**
 * Short previews for artists not in the library, from Deezer. An artist is
 * matched by exact name, and only when one of their Deezer albums is one of
 * their MusicBrainz release groups, so a different band with the same name
 * never plays. Matches (and "no match") are cached; audio never is.
 */
export class Previews {
  private readonly cache: SourceCache;
  private readonly audioUrls = new Map<number, { at: number; url: string }>();

  constructor(
    db: Db,
    private readonly deezer: DeezerClient,
    private readonly musicbrainz: MusicBrainzClient,
    private readonly images: ImageUrls,
    log: FastifyBaseLogger,
  ) {
    this.cache = new SourceCache(db, log);
  }

  /** The artist's top tracks as previews, or null when Deezer has no confirmed match. */
  async forArtist(mbid: string, name: string): Promise<ArtistPreview | null> {
    const deezerId = await this.cache.get<number | null>(`dz:artist:${mbid}`, MATCH_FOR_MS, () => this.match(mbid, name));
    if (!deezerId) return null;
    const tracks = await this.cache.get<CachedTrack[]>(`dz:top:${deezerId}`, TOP_FOR_MS, () => this.pick(deezerId));
    if (!tracks.length) return null;
    return {
      artistMbid: mbid,
      artistName: name,
      deezerUrl: `https://www.deezer.com/artist/${deezerId}`,
      tracks: tracks.map(({ cover, ...t }) => ({
        ...t,
        coverUrl: this.images.remote(cover),
        audioUrl: `api/v1/previews/${t.deezerTrackId}/audio`,
      })),
    };
  }

  /**
   * The artist's top tracks with previews. Some artists have none in their top
   * tracks where Offbeat runs (regional licensing), so then the first playable
   * track of each album, albums before singles, which also spreads them out.
   */
  private async pick(deezerId: number): Promise<CachedTrack[]> {
    const top = (await this.deezer.topTracks(deezerId, TOP_TRACKS)).filter((t) => t.preview);
    if (top.length) {
      return top.map((t) => ({
        deezerTrackId: t.id,
        title: t.title,
        albumTitle: t.album?.title ?? '',
        cover: t.album?.cover_big ?? t.album?.cover_medium ?? null,
        durationMs: 30_000,
      }));
    }
    const albums = (await this.deezer.albums(deezerId)).sort(
      (a, b) => Number(b.record_type === 'album') - Number(a.record_type === 'album'),
    );
    const picked: CachedTrack[] = [];
    for (const album of albums.slice(0, ALBUMS_TO_TRY)) {
      const track = (await this.deezer.albumTracks(album.id)).find((t) => t.preview);
      if (track) picked.push({ deezerTrackId: track.id, title: track.title, albumTitle: album.title, cover: album.cover_big ?? album.cover_medium ?? null, durationMs: 30_000 });
      if (picked.length === TOP_TRACKS) break;
    }
    return picked;
  }

  /** A fresh address for a track's preview audio, checked to be on Deezer's preview servers. */
  async audioUrl(deezerTrackId: number): Promise<string> {
    const cached = this.audioUrls.get(deezerTrackId);
    if (cached && Date.now() - cached.at < AUDIO_URL_FOR_MS) return cached.url;
    const url = (await this.deezer.track(deezerTrackId)).preview;
    if (!isDeezerPreviewUrl(url)) throw new DeezerError('Deezer has no preview for that track');
    if (this.audioUrls.size > 500) this.audioUrls.clear();
    this.audioUrls.set(deezerTrackId, { at: Date.now(), url });
    return url;
  }

  /** The Deezer artist with this exact name whose albums overlap the artist's on MusicBrainz, or null. */
  private async match(mbid: string, name: string): Promise<number | null> {
    const wanted = normalizeName(name);
    const candidates = (await this.deezer.searchArtists(name)).filter((a) => normalizeName(a.name) === wanted).slice(0, CANDIDATES);
    if (!candidates.length) return null;
    // A page of titles is plenty to recognise the artist, and each page costs a second.
    let groups = await this.musicbrainz.releaseGroups(mbid, { albumsOnly: true, firstPageOnly: true });
    // An artist with only EPs and singles still has something to compare.
    if (!groups.length) groups = await this.musicbrainz.releaseGroups(mbid, { firstPageOnly: true });
    const known = new Set(groups.map((g) => titleKey(g.title)).filter(Boolean));
    if (!known.size) return null;
    for (const candidate of candidates) {
      const albums = await this.deezer.albums(candidate.id);
      if (albums.some((album) => known.has(titleKey(album.title)))) return candidate.id;
    }
    return null;
  }
}
