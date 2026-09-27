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
  items: Recommendation[];
}
