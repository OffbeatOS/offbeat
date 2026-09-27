import type { LastfmSettingsView } from '@offbeat/shared';
import { z } from 'zod';
import type { SettingsStore } from '../../settings/store.js';
import { LastfmClient } from './client.js';

const KEY = 'lastfm';

/** Stored encrypted; only `toLastfmView` output may reach the browser. */
const storedLastfmSchema = z.object({ apiKey: z.string() });
export type StoredLastfm = z.infer<typeof storedLastfmSchema>;

export const loadLastfm = (store: SettingsStore) => store.get(KEY, storedLastfmSchema);

export const saveLastfm = (store: SettingsStore, value: StoredLastfm) => store.set(KEY, value, { encrypted: true });

export const clearLastfm = (store: SettingsStore) => store.delete(KEY);

export function toLastfmView(settings: StoredLastfm | null): LastfmSettingsView {
  return { configured: !!settings, keyEnding: settings ? settings.apiKey.slice(-4) : null };
}

/** A Last.fm client for the saved key, or null when Last.fm is not connected. */
export function lastfmClientFor(store: SettingsStore, url?: string, timeoutMs?: number): LastfmClient | null {
  const settings = loadLastfm(store);
  return settings ? new LastfmClient({ apiKey: settings.apiKey, url, timeoutMs }) : null;
}
