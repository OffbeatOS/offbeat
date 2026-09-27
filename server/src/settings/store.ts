import { eq, sql } from 'drizzle-orm';
import type { z } from 'zod';
import type { SecretBox } from '../crypto/secret-box.js';
import type { Db } from '../db/index.js';
import { settings } from '../db/schema.js';

/**
 * Typed access to the `settings` table. Values are JSON; sections holding
 * credentials are stored encrypted as a whole.
 */
export class SettingsStore {
  constructor(
    private readonly db: Db,
    private readonly box: SecretBox,
  ) {}

  get<T extends z.ZodType>(key: string, schema: T): z.infer<T> | null {
    const row = this.db.select().from(settings).where(eq(settings.key, key)).get();
    if (!row) return null;
    const json = row.encrypted ? this.box.decrypt(row.value) : row.value;
    return schema.parse(JSON.parse(json));
  }

  set(key: string, value: unknown, { encrypted }: { encrypted: boolean }) {
    const json = JSON.stringify(value);
    const stored = encrypted ? this.box.encrypt(json) : json;
    this.db
      .insert(settings)
      .values({ key, value: stored, encrypted })
      .onConflictDoUpdate({
        target: settings.key,
        set: { value: stored, encrypted, updatedAt: sql`(unixepoch())` },
      })
      .run();
  }

  delete(key: string) {
    this.db.delete(settings).where(eq(settings.key, key)).run();
  }

  has(key: string): boolean {
    return !!this.db.select({ key: settings.key }).from(settings).where(eq(settings.key, key)).get();
  }
}
