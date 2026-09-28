/**
 * The user's feedback applied to recommendations, as pure functions: tag
 * weights from thumbs up and down, blocked tags, and the per-seed cap again
 * after re-ordering. Runs after genres are known (see Discovery.enrich).
 */
import { SEED_CAP } from './engine.js';

/** Net votes per genre (lower case): +1 for each thumbs up on an artist with it, -1 for each thumbs down. */
export type TagWeights = ReadonlyMap<string, number>;

export function tagWeights(ratings: { value: number; genres: string[] }[]): Map<string, number> {
  const weights = new Map<string, number>();
  for (const rating of ratings) {
    for (const genre of new Set(rating.genres.map((g) => g.toLowerCase()))) {
      weights.set(genre, (weights.get(genre) ?? 0) + Math.sign(rating.value));
    }
  }
  return weights;
}

/**
 * How much a pick's genres nudge its score: each genre adds or removes up to
 * 15 percent, saturating (tanh) so a handful of votes matters but no genre
 * runs away with the list. Bounded to between 0.4 and 1.6.
 */
export function tasteFactor(genres: readonly string[], weights: TagWeights): number {
  let sum = 0;
  for (const genre of genres) sum += Math.tanh((weights.get(genre.toLowerCase()) ?? 0) / 2);
  return Math.min(1.6, Math.max(0.4, 1 + 0.15 * sum));
}

interface Scored {
  mbid: string;
  score: number;
  genres: string[];
  reason: { seedMbid: string };
}

/**
 * Drops picks with a blocked tag, re-weights the rest by taste, re-orders
 * them, and scales scores so the top is 100 again. Then no seed explains more
 * than SEED_CAP.perSeed of the top SEED_CAP.top (picks past that wait below).
 */
export function applyTaste<T extends Scored>(items: T[], weights: TagWeights, blockedTags: ReadonlySet<string>): T[] {
  const kept = items
    .filter((item) => !item.genres.some((g) => blockedTags.has(g.toLowerCase())))
    .map((item) => ({ item, score: item.score * tasteFactor(item.genres, weights) }))
    .sort((a, b) => b.score - a.score);
  const top = kept[0]?.score || 1;
  const rescored = kept.map(({ item, score }) => ({ ...item, score: Math.round((score / top) * 1000) / 10 }));

  const counts = new Map<string, number>();
  const head: T[] = [];
  const tail: T[] = [];
  for (const item of rescored) {
    const seed = item.reason.seedMbid;
    if (head.length < SEED_CAP.top && (counts.get(seed) ?? 0) < SEED_CAP.perSeed) {
      counts.set(seed, (counts.get(seed) ?? 0) + 1);
      head.push(item);
    } else {
      tail.push(item);
    }
  }
  return [...head, ...tail];
}
