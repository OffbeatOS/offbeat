import type { ReleaseStatus, ReleaseType } from '@offbeat/shared';
import type { LidarrAlbum } from '../integrations/lidarr/client.js';

/** Secondary types that make a release something other than a regular album or EP. */
const OTHER_SECONDARY = new Set([
  'live',
  'remix',
  'dj-mix',
  'mixtape/street',
  'demo',
  'interview',
  'spokenword',
  'audiobook',
  'audio drama',
  'field recording',
  'soundtrack',
]);

/** Accepts MusicBrainz (strings) and Lidarr (strings or {name}) secondary type lists. */
function secondaryNames(secondaryTypes: readonly unknown[] | null | undefined): string[] {
  return (secondaryTypes ?? [])
    .map((s) => (typeof s === 'string' ? s : typeof s === 'object' && s && 'name' in s ? String(s.name) : ''))
    .map((s) => s.toLowerCase())
    .filter(Boolean);
}

export function releaseType(primary: string | null | undefined, secondaryTypes: readonly unknown[] | null | undefined): ReleaseType {
  const secondary = secondaryNames(secondaryTypes);
  if (secondary.includes('compilation')) return 'Compilation';
  if (secondary.some((s) => OTHER_SECONDARY.has(s))) return 'Other';
  switch ((primary ?? '').toLowerCase()) {
    case 'album':
      return 'Album';
    case 'ep':
      return 'EP';
    case 'single':
      return 'Single';
    default:
      return 'Other';
  }
}

/** What the Artist page shows by default: albums, EPs, and compilations. Never crowded. */
export const SHOWN_TYPES: ReadonlySet<ReleaseType> = new Set(['Album', 'EP', 'Compilation']);

export function yearOf(date: string | null | undefined): number | null {
  const year = Number(date?.slice(0, 4));
  return Number.isFinite(year) && year > 0 ? year : null;
}

/** The album's real track count (see the note on totalTrackCount). */
export function albumTrackTotal(album: LidarrAlbum): number {
  const stats = album.statistics;
  return stats?.totalTrackCount || stats?.trackCount || 0;
}

/** Status chip rules (docs/design), applied to a Lidarr album. */
export function lidarrStatus(album: LidarrAlbum): ReleaseStatus {
  const files = album.statistics?.trackFileCount ?? 0;
  const total = albumTrackTotal(album);
  if (total > 0 && files >= total) return { kind: 'in-library' };
  if (files > 0) return { kind: 'partial', missingTracks: Math.max(0, total - files) };
  return album.monitored ? { kind: 'requested' } : { kind: 'available' };
}

/** Folds case, accents, and punctuation, for "is this the thing they typed" checks. */
export function normalize(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '');
}

export const MBID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
