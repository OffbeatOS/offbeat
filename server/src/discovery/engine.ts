/**
 * The recommendation engine, as pure functions: no network, no database. The
 * Discovery service fetches similar artists and popularity, then hands them
 * here to be combined, scored, filtered, and ranked per mode (see
 * docs/architecture.md, Discovery engine).
 */

export type DiscoveryMode = 'safer' | 'balanced' | 'deeper';
export const MODES: readonly DiscoveryMode[] = ['safer', 'balanced', 'deeper'];
export type SourceName = 'listenbrainz' | 'lastfm';

/** When Last.fm is connected it is the preferred source; artists both sources agree on score highest. */
export const SOURCE_WEIGHTS: Record<SourceName, number> = { lastfm: 0.6, listenbrainz: 0.4 };

/**
 * ListenBrainz similarity counts listening sessions, so artists everyone plays
 * score high next to anything. Dividing by a power of an artist's listener
 * count keeps what is over-represented next to the seed rather than what is
 * popular everywhere. The power is small, because ListenBrainz undercounts
 * some well-known artists, and below the floor no extra lift is given, so a
 * data gap or a tiny artist is never catapulted to the top.
 */
export const LISTENER_FLOOR = 20_000;
export const POPULARITY_EXPONENT = 0.3;

/**
 * ListenBrainz popularity has gaps: some well-known artists show a fraction of
 * their real listeners. A count below a quarter of the typical one for the
 * same list is not trusted that far, so a gap cannot pass for a niche artist.
 */
export function trustedListeners(listeners: number, typical: number): number {
  return Math.max(LISTENER_FLOOR, typical / 4, listeners);
}

function median(values: number[]): number | undefined {
  if (!values.length) return undefined;
  return [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
}

/** MusicBrainz's placeholder artist for compilations; never a recommendation. */
export const VARIOUS_ARTISTS = '89ad4ac3-39f7-470e-963a-56509c546377';

export interface Seed {
  mbid: string;
  name: string;
  /** How much this seed counts; higher for artists the user plays more. */
  weight: number;
  inLibrary: boolean;
  plays: number;
}

/** One source's similar artists for one artist. ListenBrainz strengths are raw; Last.fm's are 0 to 1. */
export interface SimilarLists {
  listenbrainz: { mbid: string; name: string; score: number }[] | null;
  lastfm: { mbid: string | null; name: string; match: number }[] | null;
}

export interface Contribution {
  /** The seed this reason traces back to (for a second hop, the seed behind the parent). */
  seed: Seed;
  /** Similarity from 0 to 1, times any hop discount. */
  match: number;
  /** For a second hop: the recommended artist this one is similar to. */
  via?: { mbid: string | null; name: string };
}

export interface Candidate {
  /** The MBID, or `name:<normalized name>` until the name is resolved. */
  key: string;
  mbid: string | null;
  name: string;
  contributions: Contribution[];
  sources: Set<SourceName>;
}

export interface Ranked {
  mbid: string;
  name: string;
  /** 0 to 100, relative to the top pick in this list. */
  score: number;
  reason: { seed: string; seedMbid: string; via: string | null };
  /** Up to three seeds that led here, strongest first. */
  seeds: string[];
  sources: SourceName[];
  listeners: number | null;
}

/** Names compared loosely: case, accents, dash and quote styles, and a leading "The" do not matter. */
export function normalizeName(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[‐-―−]/g, '-')
    .replace(/[‘’ʼ`]/g, "'")
    .replace(/&/g, 'and')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^the /, '');
}

/**
 * One seed's similar artists from both sources, merged into 0 to 1 matches.
 * ListenBrainz strengths are corrected for popularity (see LISTENER_FLOOR),
 * then scaled by the strongest in the list. Last.fm entries without an MBID
 * borrow one from a ListenBrainz entry of the same name. When a source has
 * nothing for this seed, the other counts in full.
 */
export function mergeSimilar(
  lists: SimilarLists,
  listeners?: ReadonlyMap<string, number>,
): Map<string, { mbid: string | null; name: string; match: number; sources: Set<SourceName> }> {
  const known = (lists.listenbrainz ?? []).map((a) => listeners?.get(a.mbid)).filter((n): n is number => !!n);
  // Artists with no popularity data are treated as typical for this list.
  const typical = median(known) ?? LISTENER_FLOOR;
  const lb = (lists.listenbrainz ?? []).map((a) => ({
    ...a,
    score: listeners ? a.score / trustedListeners(listeners.get(a.mbid) ?? typical, typical) ** POPULARITY_EXPONENT : a.score,
  }));
  const lf = lists.lastfm ?? [];
  const top = Math.max(0, ...lb.map((a) => a.score));
  const lbWeight = lf.length === 0 ? 1 : SOURCE_WEIGHTS.listenbrainz;
  const lfWeight = lb.length === 0 ? 1 : SOURCE_WEIGHTS.lastfm;

  const merged = new Map<string, { mbid: string | null; name: string; match: number; sources: Set<SourceName> }>();
  const byName = new Map<string, string>();
  for (const a of lb) {
    if (!top) break;
    const key = a.mbid;
    merged.set(key, { mbid: a.mbid, name: a.name, match: (a.score / top) * lbWeight, sources: new Set(['listenbrainz']) });
    byName.set(normalizeName(a.name), key);
  }
  for (const a of lf) {
    const key = a.mbid ?? byName.get(normalizeName(a.name)) ?? `name:${normalizeName(a.name)}`;
    const existing = merged.get(key);
    const match = Math.max(0, Math.min(1, a.match)) * lfWeight;
    if (existing) {
      existing.match += match;
      existing.sources.add('lastfm');
    } else {
      merged.set(key, { mbid: key.startsWith('name:') ? null : key, name: a.name, match, sources: new Set(['lastfm']) });
    }
  }
  return merged;
}

/**
 * Adds each seed's similar artists to the candidate pool. `via` marks a
 * second hop and `discount` scales it. `listeners` enables the ListenBrainz
 * popularity correction.
 */
export function gather(
  pool: Map<string, Candidate>,
  seeds: { seed: Seed; lists: SimilarLists; via?: { mbid: string | null; name: string }; discount?: number }[],
  listeners?: ReadonlyMap<string, number>,
): Map<string, Candidate> {
  for (const { seed, lists, via, discount = 1 } of seeds) {
    for (const [key, similar] of mergeSimilar(lists, listeners)) {
      if (similar.match <= 0) continue;
      let candidate = pool.get(key);
      if (!candidate) {
        candidate = { key, mbid: similar.mbid, name: similar.name, contributions: [], sources: new Set() };
        pool.set(key, candidate);
      }
      candidate.contributions.push({ seed, match: similar.match * discount, ...(via ? { via } : {}) });
      for (const source of similar.sources) candidate.sources.add(source);
    }
  }
  return pool;
}

/**
 * Moves a candidate to the MBID its name resolved to, folding it into an
 * existing candidate with that MBID. Used for Last.fm names without an MBID,
 * and for Last.fm MBIDs that point at a different artist of the same name.
 */
export function resolveCandidate(pool: Map<string, Candidate>, key: string, mbid: string, name?: string) {
  const candidate = pool.get(key);
  if (!candidate || key === mbid) return;
  pool.delete(key);
  const target = pool.get(mbid);
  if (target) {
    target.contributions.push(...candidate.contributions);
    for (const source of candidate.sources) target.sources.add(source);
  } else {
    pool.set(mbid, { ...candidate, key: mbid, mbid, name: name ?? candidate.name });
  }
}

/** Distinct seeds behind a candidate: artists recommended by many seeds rise. */
function seedHits(candidate: Candidate): number {
  return new Set(candidate.contributions.map((c) => c.seed.mbid)).size;
}

/**
 * Deeper mode demotes what everyone already listens to. Dividing by the log
 * of ListenBrainz listeners keeps it gentle: an artist with 100,000 listeners
 * keeps about 55 percent of its score, one with 1,000 keeps about 90 percent.
 */
export function popularityFactor(listeners: number | null | undefined): number {
  if (!listeners || listeners <= 0) return 1;
  return 1 / (1 + 0.35 * Math.log10(1 + listeners / 1000));
}

/** The raw score of a candidate in a mode, before variety. */
export function modeScore(candidate: Candidate, mode: DiscoveryMode, listeners?: number | null): number {
  const hits = seedHits(candidate);
  const direct = candidate.contributions.filter((c) => !c.via);
  switch (mode) {
    case 'safer': {
      // Strong matches from many seeds; second hops do not count here.
      const sum = direct.reduce((total, c) => total + c.match * c.match * c.seed.weight, 0);
      return sum * (1 + 0.3 * (hits - 1));
    }
    case 'balanced': {
      const sum = direct.reduce((total, c) => total + c.match * c.seed.weight, 0);
      return sum * (1 + 0.15 * (hits - 1));
    }
    case 'deeper': {
      // Second hops count, and popularity is penalized firmly.
      const sum = candidate.contributions.reduce((total, c) => total + c.match * c.seed.weight, 0);
      return sum * (1 + 0.1 * (hits - 1)) * popularityFactor(listeners) ** 2;
    }
  }
}

/** A deterministic random source, so a refresh can be reproduced from its seed. */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0 || 1;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 4294967296;
  };
}

export interface RankOptions {
  /** MBIDs never recommended: the library, the seeds, the blocklist. */
  exclude: ReadonlySet<string>;
  /** Normalized names never recommended, for artists that could not be resolved to an MBID. */
  excludeNames?: ReadonlySet<string>;
  listeners?: ReadonlyMap<string, number>;
  /** 0 to 1; each score is multiplied by a random factor within plus or minus half of this. */
  variety?: number;
  random?: () => number;
  limit?: number;
}

/** Scores, filters, varies, and ranks candidates for one mode. Name-only candidates are skipped. */
export function rank(pool: Iterable<Candidate>, mode: DiscoveryMode, options: RankOptions): Ranked[] {
  const { exclude, excludeNames, listeners, variety = 0.2, random = Math.random, limit = 50 } = options;
  const typical = median([...(listeners?.values() ?? [])]) ?? LISTENER_FLOOR;
  const scored: { candidate: Candidate; score: number }[] = [];
  for (const candidate of pool) {
    if (!candidate.mbid || exclude.has(candidate.mbid) || candidate.mbid === VARIOUS_ARTISTS) continue;
    if (excludeNames?.has(normalizeName(candidate.name))) continue;
    if (mode !== 'deeper' && candidate.contributions.every((c) => c.via)) continue;
    const known = listeners?.get(candidate.mbid);
    const raw = modeScore(candidate, mode, known === undefined ? undefined : trustedListeners(known, typical));
    if (raw <= 0) continue;
    scored.push({ candidate, score: raw * (1 + (random() - 0.5) * variety) });
  }
  scored.sort((a, b) => b.score - a.score);
  const top = scored[0]?.score ?? 1;
  return scored.slice(0, limit).map(({ candidate, score }) => explain(candidate, mode, (score / top) * 100, listeners));
}

/**
 * "Because you like X": the seed behind the strongest contribution. Only
 * Deeper uses second hops, so only Deeper can explain one ("Y, like X").
 */
function explain(candidate: Candidate, mode: DiscoveryMode, score: number, listeners?: ReadonlyMap<string, number>): Ranked {
  const bySeed = new Map<string, { seed: Seed; value: number; via: string | null }>();
  for (const c of candidate.contributions) {
    if (c.via && mode !== 'deeper') continue;
    const value = c.match * c.seed.weight;
    const current = bySeed.get(c.seed.mbid);
    if (!current || value > current.value) bySeed.set(c.seed.mbid, { seed: c.seed, value, via: c.via?.name ?? null });
  }
  const strongest = [...bySeed.values()].sort((a, b) => b.value - a.value);
  const best = strongest[0]!;
  return {
    mbid: candidate.mbid!,
    name: candidate.name,
    score: Math.round(score * 10) / 10,
    reason: { seed: best.seed.name, seedMbid: best.seed.mbid, via: best.via },
    seeds: strongest.slice(0, 3).map((s) => s.seed.name),
    sources: [...candidate.sources].sort(),
    listeners: listeners?.get(candidate.mbid!) ?? null,
  };
}

/**
 * Seeds from the library and listening history. Library artists count at
 * least 1; plays add weight on a log scale. Artists the user plays but has
 * not added count too, if they have been played a few times.
 */
export function buildSeeds(
  library: { mbid: string; name: string }[],
  listened: { mbid: string | null; name: string; plays: number }[],
  { maxSeeds = 60, minPlays = 3 } = {},
): Seed[] {
  const plays = new Map<string, number>();
  const namesToMbid = new Map(library.map((a) => [normalizeName(a.name), a.mbid]));
  const extra = new Map<string, { mbid: string; name: string }>();
  for (const artist of listened) {
    const mbid = artist.mbid ?? namesToMbid.get(normalizeName(artist.name));
    if (!mbid) continue;
    plays.set(mbid, (plays.get(mbid) ?? 0) + artist.plays);
    if (!extra.has(mbid)) extra.set(mbid, { mbid, name: artist.name });
  }
  const inLibrary = new Set(library.map((a) => a.mbid));
  const weightFor = (count: number, fromLibrary: boolean) =>
    (fromLibrary ? 1 : 0) + Math.log10(1 + count) / 2;
  const seeds: Seed[] = library.map((a) => ({
    mbid: a.mbid,
    name: a.name,
    inLibrary: true,
    plays: plays.get(a.mbid) ?? 0,
    weight: weightFor(plays.get(a.mbid) ?? 0, true),
  }));
  for (const artist of extra.values()) {
    const count = plays.get(artist.mbid) ?? 0;
    if (inLibrary.has(artist.mbid) || count < minPlays) continue;
    seeds.push({ ...artist, inLibrary: false, plays: count, weight: weightFor(count, false) });
  }
  return seeds.sort((a, b) => b.weight - a.weight).slice(0, maxSeeds);
}
