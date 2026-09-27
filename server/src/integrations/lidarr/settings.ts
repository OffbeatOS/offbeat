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
});
export type StoredLidarr = z.infer<typeof storedLidarrSchema>;

export const loadLidarr = (store: SettingsStore) => store.get(KEY, storedLidarrSchema);

export const saveLidarr = (store: SettingsStore, value: StoredLidarr) =>
  store.set(KEY, value, { encrypted: true });

export const isLidarrConfigured = (store: SettingsStore) => store.has(KEY);

export function toView({ url, qualityProfileId, metadataProfileId, rootFolderPath }: StoredLidarr): LidarrSettingsView {
  return { url, qualityProfileId, metadataProfileId, rootFolderPath };
}

export function clientFor(settings: StoredLidarr, timeoutMs?: number) {
  return new LidarrClient({ url: settings.url, apiKey: settings.apiKey, timeoutMs });
}
