import { describe, expect, it } from 'vitest';
import {
  type Candidate,
  type Seed,
  type SimilarLists,
  VARIOUS_ARTISTS,
  buildSeeds,
  gather,
  mergeSimilar,
  normalizeName,
  popularityFactor,
  rank,
  resolveCandidate,
  seededRandom,
  trustedListeners,
} from '../src/discovery/engine.js';

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
