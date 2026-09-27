import type { ReleaseStatus } from './catalog.js';

/**
 * Where an item stands, in plain terms. Lidarr's own status fields are mapped
 * onto these on the server.
 * - `adding`: Offbeat is still adding it to Lidarr
 * - `searching`: Lidarr is searching indexers for it
 * - `queued`, `downloading`, `importing`: in the download client, or being imported
 * - `paused`: paused in the download client
 * - `import-blocked`: downloaded, but Lidarr would not import it (usually fixed in Lidarr)
 * - `failed`: the download failed, or Offbeat could not add it
 */
export type ActivityState =
  | 'adding'
  | 'searching'
  | 'queued'
  | 'downloading'
  | 'importing'
  | 'paused'
  | 'import-blocked'
  | 'failed';

export interface ActivityItem {
  /** Stable key: `queue:<lidarr queue id>`, `search:<album id>`, or `add:<release group mbid>`. */
  id: string;
  state: ActivityState;
  /** Release group MBID, when the item maps to a known album. */
  albumMbid: string | null;
  albumTitle: string;
  artistMbid: string | null;
  artistName: string;
  coverUrl: string | null;
  /** 0 to 1 while downloading, else null. */
  progress: number | null;
  /** Short status detail, for example "64%, about 3 min left". */
  detail: string;
  /** Why it needs attention, in plain words. */
  reason: string | null;
  /** Lidarr's own messages behind `reason`, deduplicated. */
  messages: string[];
  /** "requested by <user>" for adds made through Offbeat, "Added in Lidarr" otherwise. */
  source: string;
  canRetry: boolean;
  canCancel: boolean;
  /** Where to fix it in Lidarr (its Activity page, or the album's page for a manual search). */
  lidarrLink: string | null;
}

export interface CompletedItem {
  id: string;
  albumMbid: string | null;
  albumTitle: string;
  artistMbid: string | null;
  artistName: string;
  coverUrl: string | null;
  /** ISO timestamp of the import. */
  date: string;
  source: string;
}

/** Sent over `GET /events` as the `activity` event, and returned by `GET /activity`. */
export interface ActivitySnapshot {
  attention: ActivityItem[];
  inProgress: ActivityItem[];
  completed: CompletedItem[];
  /** ISO timestamp of the last successful poll of Lidarr. */
  updatedAt: string | null;
  /** Set when Lidarr could not be reached on the last poll. */
  error: string | null;
}

/** Sent over `GET /events` as the `add-result` event when a background album add finishes. */
export interface AddResult {
  albumMbid: string;
  ok: boolean;
  /** The album's status after a successful add. */
  status: ReleaseStatus | null;
  error: string | null;
}
