import { eq } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import type { Db } from '../db/index.js';
import { sourceCache } from '../db/schema.js';

const DAY = 24 * 60 * 60 * 1000;

/** How long each kind of upstream answer stays fresh. */
export const MAX_AGE = {
  similar: 7 * DAY,
  popularity: 7 * DAY,
  lookup: 30 * DAY,
  listening: 1 * DAY,
} as const;

/**
 * Discovery's upstream answers, kept in SQLite. Fresh copies are served as
 * is; past their age they are fetched again, and if the source fails the
 * stale copy is served instead, so one outage never empties recommendations.
 */
export class SourceCache {
  private readonly inFlight = new Map<string, Promise<unknown>>();

  constructor(
    private readonly db: Db,
    private readonly log: FastifyBaseLogger,
  ) {}

  get<T>(key: string, maxAgeMs: number, fetch: () => Promise<T>): Promise<T> {
    const pending = this.inFlight.get(key);
    if (pending) return pending as Promise<T>;
    const run = this.load(key, maxAgeMs, fetch).finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, run);
    return run;
  }

  /** A fresh cached value, or undefined. For batched fetches that look up many keys first. */
  peek<T>(key: string, maxAgeMs: number): T | undefined {
    const row = this.db.select().from(sourceCache).where(eq(sourceCache.key, key)).get();
    return row && Date.now() - row.fetchedAt.getTime() < maxAgeMs ? (JSON.parse(row.body) as T) : undefined;
  }

  put(key: string, value: unknown) {
    const body = JSON.stringify(value);
    this.db
      .insert(sourceCache)
      .values({ key, body, fetchedAt: new Date() })
      .onConflictDoUpdate({ target: sourceCache.key, set: { body, fetchedAt: new Date() } })
      .run();
  }

  private async load<T>(key: string, maxAgeMs: number, fetch: () => Promise<T>): Promise<T> {
    const row = this.db.select().from(sourceCache).where(eq(sourceCache.key, key)).get();
    if (row && Date.now() - row.fetchedAt.getTime() < maxAgeMs) return JSON.parse(row.body) as T;
    try {
      const value = await fetch();
      this.put(key, value);
      return value;
    } catch (error) {
      if (!row) throw error;
      this.log.warn({ err: error, key }, 'Discovery source failed; using the cached copy');
      return JSON.parse(row.body) as T;
    }
  }
}
