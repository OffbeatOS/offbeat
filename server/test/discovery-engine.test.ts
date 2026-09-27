import { describe, expect, it } from 'vitest';
import {
  type Candidate,
  type Seed,
  type SimilarLists,
  VARIOUS_ARTISTS,
  buildSeeds,
  capSeeds,
  gather,
  mergeSimilar,
  normalizeName,
  popularityFactor,
  rank,
  resolveCandidate,
  seededRandom,
  trustedListeners,
} from '../src/discovery/engine.js';
import { genreLabel, pickGenres } from '../src/discovery/genres.js';

const seed = (name: string, weight = 1): Seed => ({ mbid: `mbid-${name}`, name, weight, inLibrary: true, plays: 0 });
const lb = (...entries: [string, number][]): SimilarLists['listenbrainz'] =>
  entries.map(([name, score]) => ({ mbid: `mbid-${name}`, name, score }));
const lf = (...entries: [string, number, boolean?][]): SimilarLists['lastfm'] =>
  entries.map(([name, match, withMbid = true]) => ({ mbid: withMbid ? `mbid-${name}` : null, name, match }));
const noExclusions = { exclude: new Set<string>(), variety: 0 };

describe('normalizeName', () => {
  it('ignores case, accents, dash and quote styles, ampersands, and a leading The', () => {
    expect(normalizeName('The Offspring')).toBe(normalizeName('offspring'));
    expect(normalizeName('blink‐182')).toBe('blink-182');
    expect(normalizeName('Sigur Rós')).toBe('sigur ros');
    expect(normalizeName('Guns N’ Roses')).toBe("guns n' roses");
    expect(normalizeName('Simon & Garfunkel')).toBe('simon and garfunkel');
  });
});

describe('mergeSimilar', () => {
  it('scales ListenBrainz strengths by the strongest, alone at full weight', () => {
    const merged = mergeSimilar({ listenbrainz: lb(['A', 2000], ['B', 500]), lastfm: null });
    expect(merged.get('mbid-A')?.match).toBe(1);
    expect(merged.get('mbid-B')?.match).toBe(0.25);
  });

  it('prefers Last.fm when both have something, and rewards agreement', () => {
    const merged = mergeSimilar({ listenbrainz: lb(['A', 1000], ['B', 1000]), lastfm: lf(['A', 1], ['C', 1]) });
    expect(merged.get('mbid-A')?.match).toBeCloseTo(1); // both agree: 0.4 + 0.6
    expect(merged.get('mbid-C')?.match).toBeCloseTo(0.6); // Last.fm only
    expect(merged.get('mbid-B')?.match).toBeCloseTo(0.4); // ListenBrainz only
    expect([...merged.get('mbid-A')!.sources].sort()).toEqual(['lastfm', 'listenbrainz']);
  });

  it('corrects ListenBrainz for popularity, so artists played everywhere do not crowd out close matches', () => {
    const lists = { listenbrainz: lb(['Hub', 3000], ['Close', 1500], ['A', 900], ['B', 800], ['C', 700]), lastfm: null };
    const raw = mergeSimilar(lists);
    expect(raw.get('mbid-Hub')!.match).toBeGreaterThan(raw.get('mbid-Close')!.match);
    const corrected = mergeSimilar(
      lists,
      new Map([['mbid-Hub', 450_000], ['mbid-Close', 40_000], ['mbid-A', 60_000], ['mbid-B', 50_000], ['mbid-C', 45_000]]),
    );
    expect(corrected.get('mbid-Close')!.match).toBe(1);
    expect(corrected.get('mbid-Hub')!.match).toBeLessThan(1); // twice the co-listening, but ten times the listeners
    // Below the floor, small artists get no extra lift.
    const tiny = mergeSimilar(
      { listenbrainz: lb(['Known', 1000], ['Tiny', 1000]), lastfm: null },
      new Map([['mbid-Known', 5000], ['mbid-Tiny', 50]]),
    );
    expect(tiny.get('mbid-Tiny')!.match).toBe(tiny.get('mbid-Known')!.match);
  });

  it('counts one source in full when the other knows nothing about the seed', () => {
    expect(mergeSimilar({ listenbrainz: [], lastfm: lf(['C', 0.8]) }).get('mbid-C')?.match).toBeCloseTo(0.8);
  });

  it('gives a Last.fm name without an MBID the MBID of the same ListenBrainz artist', () => {
    const merged = mergeSimilar({ listenbrainz: lb(['The Offspring', 1000]), lastfm: lf(['Offspring', 0.5, false]) });
    expect([...merged.keys()]).toEqual(['mbid-The Offspring']);
    const unmatched = mergeSimilar({ listenbrainz: lb(['A', 1000]), lastfm: lf(['Nobody Known', 0.5, false]) });
    expect(unmatched.get('name:nobody known')?.mbid).toBeNull();
  });
});

describe('ranking', () => {
  const pool = (entries: { seed: Seed; lists: SimilarLists }[]) => gather(new Map<string, Candidate>(), entries);

  it('never recommends the library, the seeds, or Various Artists', () => {
    const nofx = seed('NOFX');
    const ranked = rank(
      pool([{ seed: nofx, lists: { listenbrainz: lb(['NOFX', 950], ['Rancid', 900], ['Lagwagon', 800]), lastfm: null } }]).values(),
      'balanced',
      { ...noExclusions, exclude: new Set(['mbid-NOFX', 'mbid-Rancid']) },
    );
    expect(ranked.map((r) => r.name)).toEqual(['Lagwagon']);
    // Various Artists (by its real MBID) never appears either:
    const va = pool([{ seed: nofx, lists: { listenbrainz: [{ mbid: VARIOUS_ARTISTS, name: 'Various Artists', score: 1 }], lastfm: null } }]);
    expect(rank(va.values(), 'balanced', noExclusions)).toEqual([]);
  });

  it('explains each pick with the seed behind its strongest match', () => {
    const [top] = rank(
      pool([
        { seed: seed('NOFX'), lists: { listenbrainz: lb(['Lagwagon', 1000]), lastfm: null } },
        { seed: seed('Bad Religion', 2), lists: { listenbrainz: lb(['Lagwagon', 800]), lastfm: null } },
      ]).values(),
      'balanced',
      noExclusions,
    );
    expect(top).toMatchObject({ name: 'Lagwagon', score: 100, reason: { seed: 'Bad Religion', via: null }, seeds: ['Bad Religion', 'NOFX'] });
  });

  it('Safer lifts artists several seeds agree on over a single strong match', () => {
    const entries = [
      { seed: seed('S1'), lists: { listenbrainz: lb(['Solo', 1000], ['Shared', 700]), lastfm: null } },
      { seed: seed('S2'), lists: { listenbrainz: lb(['Other', 1000], ['Shared', 700]), lastfm: null } },
    ];
    expect(rank(pool(entries).values(), 'safer', noExclusions)[0]?.name).toBe('Shared');
  });

  it('Deeper counts second hops and demotes very popular artists', () => {
    const s = seed('NOFX');
    const p = pool([{ seed: s, lists: { listenbrainz: lb(['Famous', 1000], ['Niche', 900]), lastfm: null } }]);
    gather(p, [{ seed: s, lists: { listenbrainz: lb(['Deep Cut', 1000]), lastfm: null }, via: { mbid: 'mbid-Niche', name: 'Niche' }, discount: 0.5 }]);
    const listeners = new Map([['mbid-Famous', 500_000], ['mbid-Niche', 800], ['mbid-Deep Cut', 300]]);
    const deeper = rank(p.values(), 'deeper', { ...noExclusions, listeners });
    // Famous has the stronger match, but half a million listeners puts Niche ahead.
    expect(deeper[0]?.name).toBe('Niche');
    expect(rank(p.values(), 'balanced', { ...noExclusions, listeners })[0]?.name).toBe('Famous');
    expect(deeper.find((r) => r.name === 'Deep Cut')?.reason).toEqual({ seed: 'NOFX', seedMbid: 'mbid-NOFX', via: 'Niche' });
    // Second hops never show up outside Deeper.
    expect(rank(p.values(), 'balanced', noExclusions).map((r) => r.name)).not.toContain('Deep Cut');
  });

  it('does not trust a listener count far below the typical one (a data gap, not a niche artist)', () => {
    expect(trustedListeners(6_000, 100_000)).toBe(25_000);
    expect(trustedListeners(30_000, 100_000)).toBe(30_000);
    expect(trustedListeners(100, 1_000)).toBe(20_000); // the floor
  });

  it('keeps the popularity penalty gentle', () => {
    expect(popularityFactor(null)).toBe(1);
    expect(popularityFactor(1_000)).toBeGreaterThan(0.88);
    expect(popularityFactor(100_000)).toBeGreaterThan(0.5);
    expect(popularityFactor(100_000)).toBeLessThan(0.6);
  });

  it('skips names it could not resolve, and folds resolved ones into the same artist', () => {
    const p = pool([{ seed: seed('NOFX'), lists: { listenbrainz: lb(['Lagwagon', 1000]), lastfm: lf(['Mystery', 0.9, false], ['lagwagon!', 0.5, false]) } }]);
    expect(rank(p.values(), 'balanced', noExclusions).map((r) => r.name)).toEqual(['Lagwagon']);
    resolveCandidate(p, 'name:lagwagon!', 'mbid-Lagwagon');
    expect(p.get('mbid-Lagwagon')?.contributions).toHaveLength(2);
    expect(p.has('name:lagwagon!')).toBe(false);
  });

  it('varies the order a little between refreshes, reproducibly', () => {
    const lists = { listenbrainz: lb(...Array.from({ length: 30 }, (_, i) => [`A${i}`, 1000 - i] as [string, number])), lastfm: null };
    const order = (random: () => number) =>
      rank(pool([{ seed: seed('S'), lists }]).values(), 'balanced', { exclude: new Set(), random }).map((r) => r.name);
    expect(order(seededRandom(7))).toEqual(order(seededRandom(7)));
    expect(order(seededRandom(7))).not.toEqual(order(seededRandom(8)));
    const steady = rank(pool([{ seed: seed('S'), lists }]).values(), 'balanced', noExclusions).map((r) => r.name);
    expect(steady.slice(0, 3)).toEqual(['A0', 'A1', 'A2']);
  });
});

describe('buildSeeds', () => {
  const library = [
    { mbid: 'm-nofx', name: 'NOFX' },
    { mbid: 'm-boc', name: 'Boards of Canada' },
  ];

  it('gives every library artist weight, and more to artists the user plays', () => {
    const seeds = buildSeeds(library, [{ mbid: null, name: 'nofx', plays: 999 }]);
    expect(seeds.map((s) => s.name)).toEqual(['NOFX', 'Boards of Canada']);
    expect(seeds[0]!.weight).toBeGreaterThan(seeds[1]!.weight);
    expect(seeds[1]!.weight).toBe(1);
  });

  it('adds played artists outside the library once they have a few plays', () => {
    const seeds = buildSeeds(library, [
      { mbid: 'm-rancid', name: 'Rancid', plays: 40 },
      { mbid: 'm-once', name: 'Heard Once', plays: 1 },
    ]);
    expect(seeds.map((s) => s.name)).toContain('Rancid');
    expect(seeds.map((s) => s.name)).not.toContain('Heard Once');
    expect(seeds.find((s) => s.name === 'Rancid')).toMatchObject({ inLibrary: false, plays: 40 });
  });

  it('caps the number of seeds, keeping the heaviest', () => {
    const many = Array.from({ length: 80 }, (_, i) => ({ mbid: `m${i}`, name: `A${i}` }));
    expect(buildSeeds(many, [], { maxSeeds: 60 })).toHaveLength(60);
  });
});

describe('seed cap', () => {
  const pick = (name: string, ...seeds: string[]) => ({
    ranked: { mbid: `mbid-${name}`, name, score: 0, reason: { seed: seeds[0]!, seedMbid: seeds[0]!, via: null }, seeds, sources: [], listeners: null },
    reasons: seeds.map((s) => ({ seed: s, seedMbid: s, via: null })),
  });

  it('lets no seed explain more than its share of the top, using another contributing seed when it can', () => {
    const items = [pick('A', 'NOFX'), pick('B', 'NOFX'), pick('C', 'NOFX'), pick('D', 'NOFX', 'Linkin Park'), pick('E', 'NOFX'), pick('F', 'The Prodigy')];
    const capped = capSeeds(items, { top: 5, perSeed: 3 });
    expect(capped.map((r) => r.name)).toEqual(['A', 'B', 'C', 'D', 'F', 'E']);
    expect(capped[3]!.reason.seed).toBe('Linkin Park'); // D is also like Linkin Park, which has room
    expect(capped[5]!.reason.seed).toBe('NOFX'); // E only has NOFX: it waits below the top
  });

  it('gives quieter seeds a voice in a real ranking', () => {
    const loud = seed('NOFX', 2);
    const quiet = seed('The Prodigy', 0.4);
    const lists = { listenbrainz: lb(...Array.from({ length: 12 }, (_, i) => [`Punk ${i}`, 1000 - i] as [string, number])), lastfm: null };
    const p = gather(new Map<string, Candidate>(), [
      { seed: loud, lists },
      { seed: quiet, lists: { listenbrainz: lb(['Leftfield', 1000], ['Chemical Brothers', 900]), lastfm: null } },
    ]);
    const ranked = rank(p.values(), 'balanced', noExclusions);
    // The Prodigy's picks score far lower, but come right after NOFX's first three.
    expect(ranked.slice(0, 5).map((r) => r.reason.seed)).toEqual(['NOFX', 'NOFX', 'NOFX', 'The Prodigy', 'The Prodigy']);
    // With only two seeds the cap cannot fill ten places; the rest follow in score order.
    expect(ranked).toHaveLength(14);
    expect(ranked.slice(5).every((r) => r.reason.seed === 'NOFX')).toBe(true);
  });
});

describe('genres', () => {
  it('capitalizes consistently, keeping acronyms', () => {
    expect(genreLabel('punk rock')).toBe('Punk Rock');
    expect(genreLabel('uk garage')).toBe('UK Garage');
    expect(genreLabel('idm')).toBe('IDM');
    expect(genreLabel('hip-hop')).toBe('Hip-Hop');
    expect(genreLabel('post-rock')).toBe('Post-Rock');
  });

  it('keeps real genres from Last.fm tags: no opinions, places, decades, weak tags, or the artist itself', () => {
    const tags = [
      { name: 'seen live', count: 100 },
      { name: 'Radiohead', count: 95 },
      { name: 'alternative', count: 90 },
      { name: '90s', count: 60 },
      { name: 'british', count: 50 },
      { name: 'Alternative', count: 45 },
      { name: 'art rock', count: 30 },
      { name: 'electronic', count: 20 },
      { name: 'experimental', count: 5 },
    ];
    expect(pickGenres(tags, { artistName: 'Radiohead', source: 'lastfm' })).toEqual(['Alternative', 'Art Rock', 'Electronic']);
  });

  it('takes MusicBrainz genres as they are, strongest first', () => {
    expect(pickGenres([{ name: 'punk rock', count: 11 }, { name: 'skate punk', count: 7 }], { artistName: 'NOFX', source: 'musicbrainz' })).toEqual([
      'Punk Rock',
      'Skate Punk',
    ]);
  });
});

describe('substitute reasons', () => {
  it('only lets a seed explain a pick if it contributed at least half as much as the strongest', () => {
    const nofx = seed('NOFX');
    const ccr = seed('Creedence Clearwater Revival');
    // Hub is NOFX's fourth pick, and only weakly like CCR (0.1 against 0.3 from NOFX).
    const p = gather(new Map<string, Candidate>(), [
      { seed: nofx, lists: { listenbrainz: lb(['N1', 1000], ['N2', 990], ['N3', 980], ['Hub', 300]), lastfm: null } },
      { seed: ccr, lists: { listenbrainz: lb(['Fogerty', 1000], ['Hub', 100]), lastfm: null } },
    ]);
    const ranked = rank(p.values(), 'balanced', { ...noExclusions });
    // NOFX is full after three, and CCR's link is too weak to explain Hub: it waits, still as NOFX.
    expect(ranked.find((r) => r.name === 'Hub')?.reason.seed).toBe('NOFX');
    expect(ranked.slice(0, 4).map((r) => r.name).sort()).toEqual(['Fogerty', 'N1', 'N2', 'N3']);
  });
});
