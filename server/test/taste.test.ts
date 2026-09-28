import { describe, expect, it } from 'vitest';
import { applyTaste, tagWeights, tasteFactor } from '../src/discovery/taste.js';

const pick = (mbid: string, score: number, genres: string[], seed = 'NOFX') => ({ mbid, score, genres, reason: { seedMbid: seed } });

describe('tag weights', () => {
  it('counts thumbs up and down per genre, ignoring case and repeats', () => {
    const weights = tagWeights([
      { value: 1, genres: ['Skate Punk', 'Punk Rock'] },
      { value: 1, genres: ['skate punk'] },
      { value: -1, genres: ['Nu Metal', 'Punk Rock'] },
    ]);
    expect(Object.fromEntries(weights)).toEqual({ 'skate punk': 2, 'punk rock': 0, 'nu metal': -1 });
  });

  it('nudges scores, saturating, within 0.4 to 1.6', () => {
    const weights = new Map([['skate punk', 2], ['nu metal', -1]]);
    expect(tasteFactor([], weights)).toBe(1);
    expect(tasteFactor(['Skate Punk'], weights)).toBeCloseTo(1 + 0.15 * Math.tanh(1));
    expect(tasteFactor(['Nu Metal'], weights)).toBeLessThan(1);
    expect(tasteFactor(['Skate Punk'], new Map([['skate punk', 1000]]))).toBeLessThan(1.16);
    expect(tasteFactor(['a', 'b', 'c', 'd', 'e'], new Map(['a', 'b', 'c', 'd', 'e'].map((g) => [g, -50])))).toBe(0.4);
  });
});

describe('applyTaste', () => {
  it('re-orders by taste and rescales so the top is 100', () => {
    const items = [pick('a', 100, ['Nu Metal']), pick('b', 95, ['Skate Punk'], 'MxPx')];
    const result = applyTaste(items, new Map([['skate punk', 3], ['nu metal', -3]]), new Set());
    expect(result.map((r) => r.mbid)).toEqual(['b', 'a']);
    expect(result[0]!.score).toBe(100);
  });

  it('drops picks carrying a blocked tag', () => {
    const items = [pick('a', 100, ['Pop Punk', 'Punk']), pick('b', 90, ['Skate Punk'])];
    expect(applyTaste(items, new Map(), new Set(['pop punk'])).map((r) => r.mbid)).toEqual(['b']);
  });

  it('keeps the per-seed cap after re-ordering', () => {
    const items = [
      ...['a', 'b', 'c', 'd'].map((m, i) => pick(m, 100 - i, [], 'NOFX')),
      pick('e', 50, [], 'The Prodigy'),
    ];
    expect(applyTaste(items, new Map(), new Set()).map((r) => r.mbid)).toEqual(['a', 'b', 'c', 'e', 'd']);
  });
});
