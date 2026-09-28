import type { LidarrSettingsView } from '@offbeat/shared';
import { z } from 'zod';
import type { SettingsStore } from '../../settings/store.js';
import { LidarrClient } from './client.js';

const KEY = 'lidarr';

/** Stored encrypted as a whole; only `toView` output may reach the browser. */
export const storedLidarrSchema = z.object({
  url: z.string(),
  apiKey: z.string(),
  qualityProfileId: z.number(),
  metadataProfileId: z.number(),
  rootFolderPath: z.string(),
  // Added after the first release; older saved settings get the defaults.
  addMonitored: z.boolean().default(true),
  // New setups default to 'all' (see the save route); settings saved before this
  // option existed keep 'latest', the behavior they were added with.
  addMonitorAlbums: z.enum(['latest', 'all', 'future']).default('latest'),
  searchOnAdd: z.boolean().default(true),
  addTag: z.string().nullable().default(null),
});
export type StoredLidarr = z.infer<typeof storedLidarrSchema>;

export const loadLidarr = (store: SettingsStore) => store.get(KEY, storedLidarrSchema);

export const saveLidarr = (store: SettingsStore, value: StoredLidarr) =>
  store.set(KEY, value, { encrypted: true });

export const isLidarrConfigured = (store: SettingsStore) => store.has(KEY);

export function toView(settings: StoredLidarr): LidarrSettingsView {
  const { url, qualityProfileId, metadataProfileId, rootFolderPath, addMonitored, addMonitorAlbums, searchOnAdd, addTag } =
    settings;
  return { url, qualityProfileId, metadataProfileId, rootFolderPath, addMonitored, addMonitorAlbums, searchOnAdd, addTag };
}

export function clientFor(settings: StoredLidarr, timeoutMs?: number) {
  return new LidarrClient({ url: settings.url, apiKey: settings.apiKey, timeoutMs });
}

/** A client for whatever Lidarr is configured when called, or null before setup. */
export const currentClient = (store: SettingsStore) => (): LidarrClient | null => {
  const settings = loadLidarr(store);
  return settings ? clientFor(settings) : null;
};
