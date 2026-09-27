import { normalizeName } from './engine.js';

/**
 * Last.fm tags are free-form: besides genres they include opinions, places,
 * and listening habits. These never describe the music's genre.
 */
const NOT_GENRES = new Set([
  'seen live',
  'favorites',
  'favourites',
  'favorite',
  'favourite',
  'all',
  'spotify',
  'albums i own',
  'love',
  'awesome',
  'beautiful',
  'amazing',
  'cool',
  'male vocalists',
  'female vocalists',
  'male vocalist',
  'female vocalist',
  'singer-songwriter',
  'american',
  'british',
  'english',
  'canadian',
  'australian',
  'german',
  'french',
  'swedish',
  'usa',
  'uk',
  'california',
  'london',
  'under 2000 listeners',
]);

/** Last.fm tags below this share of the top tag (100) are too weak to show. */
const MIN_LASTFM_WEIGHT = 10;

/** Words written in capitals or with fixed casing in genre names. */
const FIXED_CASE: Record<string, string> = {
  uk: 'UK',
  us: 'US',
  dj: 'DJ',
  idm: 'IDM',
  edm: 'EDM',
  ebm: 'EBM',
  'r&b': 'R&B',
  'hip-hop': 'Hip-Hop',
  'lo-fi': 'Lo-Fi',
  'j-pop': 'J-Pop',
  'k-pop': 'K-Pop',
};

/** "punk rock" to "Punk Rock", keeping acronyms. */
export function genreLabel(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .map((word) => FIXED_CASE[word] ?? word.replace(/(^|-)([a-z])/g, (_m, dash: string, c: string) => dash + c.toUpperCase()))
    .join(' ');
}

/**
 * Display genres from Last.fm tags (when connected) or MusicBrainz genres:
 * strongest first, no opinions, places, or decades, nothing that is just the
 * artist's own name, at most `limit`.
 */
export function pickGenres(
  raw: { name: string; count: number }[],
  { artistName, source, limit = 3 }: { artistName: string; source: 'lastfm' | 'musicbrainz'; limit?: number },
): string[] {
  const artist = normalizeName(artistName);
  const seen = new Set<string>();
  const result: string[] = [];
  for (const tag of raw) {
    const name = tag.name.trim().toLowerCase();
    if (!name || NOT_GENRES.has(name) || /^\d0'?s$/.test(name) || normalizeName(name) === artist) continue;
    if (source === 'lastfm' && tag.count < MIN_LASTFM_WEIGHT) continue;
    const label = genreLabel(name);
    if (seen.has(label)) continue;
    seen.add(label);
    result.push(label);
    if (result.length === limit) break;
  }
  return result;
}
