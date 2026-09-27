/** One artist in the Library, from Offbeat's cached copy of Lidarr. */
export interface LibraryArtist {
  /** Lidarr's artist id. */
  id: number;
  /** MusicBrainz artist id, the key used across every integration. */
  mbid: string;
  name: string;
  /** Lidarr's sort name ("Cure, The"), used for A to Z ordering. */
  sortName: string;
  monitored: boolean;
  /** ISO timestamp of when the artist was added to Lidarr. */
  addedAt: string;
  albumCount: number;
  /** Monitored albums with no files yet. */
  missingAlbums: number;
  sizeOnDisk: number;
  genres: string[];
  /**
   * Offbeat's image proxy URL, relative to `<base href>`, or null when there is
   * no artwork. Never a Lidarr URL: those require the API key.
   */
  imageUrl: string | null;
}

export type LibrarySyncState = 'never' | 'syncing' | 'ok' | 'error';

export interface LibrarySync {
  state: LibrarySyncState;
  /** ISO timestamp of the last successful sync, if any. */
  lastSyncedAt: string | null;
  /** Why the last attempt failed, written for people. Set when `state` is `error`. */
  error: string | null;
}

/** `GET /library` and `POST /library/refresh`. Always answers from cache. */
export interface LibraryResponse {
  artists: LibraryArtist[];
  sync: LibrarySync;
}
