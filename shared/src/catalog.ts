/**
 * Where a release stands in Lidarr. Drives the status chip everywhere:
 * - `available`: not in Lidarr, or in Lidarr but unmonitored with no files (Add)
 * - `requested`: monitored, no files yet
 * - `partial`: some tracks on disk
 * - `in-library`: every track on disk
 */
export type ReleaseStatus =
  | { kind: 'available' }
  /** Offbeat is adding it to Lidarr in the background. */
  | { kind: 'adding' }
  | { kind: 'requested' }
  | { kind: 'partial'; missingTracks: number }
  | { kind: 'in-library' };

export type ReleaseType = 'Album' | 'EP' | 'Compilation' | 'Single' | 'Other';

export interface ReleaseSummary {
  /** MusicBrainz release group id. */
  mbid: string;
  title: string;
  type: ReleaseType;
  year: number | null;
  /** Proxied cover URL, or null. */
  coverUrl: string | null;
  artistMbid: string;
  artistName: string;
  status: ReleaseStatus;
}

export interface ArtistSummary {
  mbid: string;
  name: string;
  disambiguation: string | null;
  genres: string[];
  /** Proxied image URL, or null. */
  imageUrl: string | null;
  inLibrary: boolean;
}

export type SearchTop =
  | { kind: 'artist'; artist: ArtistSummary; albumsInLibrary: number | null; albumCount: number | null }
  | { kind: 'album'; album: ReleaseSummary };

/** `GET /search?q=` */
export interface SearchResponse {
  query: string;
  top: SearchTop | null;
  /** The top artist's albums, or albums matching the query when the top result is an album. */
  albums: ReleaseSummary[];
  artists: ArtistSummary[];
}

/** `GET /artists/:mbid`, also returned by adds and monitoring changes. */
export interface ArtistDetail extends ArtistSummary {
  overview: string | null;
  /** Wide artwork for the page header, proxied, or null. */
  bannerUrl: string | null;
  /** Null when the artist is not in Lidarr. */
  monitored: boolean | null;
  releases: ReleaseSummary[];
}

export interface Track {
  position: string;
  title: string;
  durationMs: number | null;
  /** Null when the album is not in Lidarr. */
  hasFile: boolean | null;
  /** Lidarr's file for this track, streamed from `/stream/:trackFileId`; null when there is none. */
  trackFileId: number | null;
  /**
   * The file's media type (for example audio/flac, or audio/mp4; codecs="alac"), so the
   * browser can tell whether it plays it directly or needs it transcoded. Null without a file.
   */
  mimeType: string | null;
}

/** `GET /albums/:mbid` */
export interface AlbumDetail extends ReleaseSummary {
  artistInLibrary: boolean;
  /** Whether Lidarr monitors this album; null when the album is not in Lidarr. */
  monitored: boolean | null;
  /** Tracks on disk and in total; null when the album is not in Lidarr. */
  trackFileCount: number | null;
  trackCount: number | null;
  genres: string[];
  tracks: Track[];
  /** Other releases by the same artist, for "More by". */
  more: ReleaseSummary[];
}

/** `PATCH /albums/:mbid` */
export interface UpdateAlbumRequest {
  monitored: boolean;
}

/** `POST /albums/:mbid` */
export interface AddAlbumRequest {
  artistMbid: string;
  /**
   * Go ahead even though the artist is unmonitored in Lidarr with other albums
   * still monitored, which monitoring it again resumes. Without it, that add
   * answers 409 with a message naming those albums.
   */
  resumeMonitoring?: boolean;
}

/** `PATCH /artists/:mbid` */
export interface UpdateArtistRequest {
  monitored: boolean;
}
