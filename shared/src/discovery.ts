import type { ReleaseSummary } from './catalog.js';

export type DiscoveryMode = 'safer' | 'balanced' | 'deeper';
export type DiscoverySource = 'listenbrainz' | 'lastfm';

/** One recommended artist. */
export interface Recommendation {
  mbid: string;
  name: string;
  disambiguation: string | null;
  genres: string[];
  imageUrl: string | null;
  /** 0 to 100, relative to the top pick in the same list. */
  score: number;
  /** "Because you like {seed}", or for Deeper's second hop, "{via}, which is like {seed}". */
  reason: { seed: string; seedMbid: string; via: string | null };
  /** Up to three of the user's artists that led here, strongest first. */
  seeds: string[];
  /** Which sources suggested it. */
  sources: DiscoverySource[];
  /** ListenBrainz listener count, when known. */
  listeners: number | null;
}

/** `GET /discover?mode=`. */
export interface DiscoverResponse {
  mode: DiscoveryMode;
  /** When these recommendations were made, or null before the first refresh. */
  generatedAt: string | null;
  refreshing: boolean;
  /** Why the last refresh failed, if it did. */
  error: string | null;
  seedCount: number;
  sources: { listenbrainz: boolean; lastfm: boolean };
  /** Top Picks, strongest first. */
  items: DiscoverPick[];
  /** Albums to Start With: the most played album of each top pick. */
  albums: ReleaseSummary[];
  /** Albums to Start With are still being found: true only during a first refresh. */
  albumsPending: boolean;
  /** Explore by Tag: genres across the recommendations, strongest first. */
  tags: string[];
}

/** A recommended artist as Discover shows it, including whether it is in the library now (after a quick add). */
export interface DiscoverPick extends Recommendation {
  inLibrary: boolean;
  /** The user's own rating of this pick, if any. */
  feedback: FeedbackValue | null;
}

/** An artist on a tag page. */
export interface TagArtist {
  mbid: string;
  name: string;
  disambiguation: string | null;
  imageUrl: string | null;
  inLibrary: boolean;
  /** Among the user's current recommendations. */
  recommended: boolean;
}

/** `GET /tags/:tag`. */
export interface TagPage {
  tag: string;
  artists: TagArtist[];
  albums: ReleaseSummary[];
  /** Genres that go with this one in the user's recommendations. */
  related: string[];
}

export type FeedbackValue = 'up' | 'down';

/** `POST /discover/feedback`. `null` clears a rating. */
export interface FeedbackRequest {
  mbid: string;
  value: FeedbackValue | null;
}

export type BlockSource = 'discover' | 'search' | 'settings' | 'tag';

/** An artist or tag on the user's blocklist. */
export interface BlockedItem {
  id: number;
  kind: 'artist' | 'tag';
  /** The artist's MBID, or the tag in lower case. */
  key: string;
  name: string;
  source: BlockSource;
  createdAt: string;
}

/** `GET /blocklist`. */
export interface BlocklistResponse {
  artists: BlockedItem[];
  tags: BlockedItem[];
}

/** `POST /blocklist`. */
export type BlockRequest =
  | { kind: 'artist'; mbid: string; name: string; source: BlockSource }
  | { kind: 'tag'; name: string; source: BlockSource };
