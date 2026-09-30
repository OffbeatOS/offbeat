/** `GET /settings/lastfm`. The key itself never leaves the server; only its last four characters. */
export interface LastfmSettingsView {
  configured: boolean;
  keyEnding: string | null;
}

/** `PUT /settings/lastfm`. The key is checked with Last.fm before it is saved. */
export interface LastfmSettingsRequest {
  apiKey: string;
}

/** `GET /account`: the signed-in user's own profile. */
export interface AccountView {
  username: string;
  role: 'admin' | 'user';
  lastfmUsername: string | null;
  listenbrainzUsername: string | null;
  /** Whether an admin has connected Last.fm; a Last.fm username can only be checked (and used) when so. */
  lastfmAvailable: boolean;
  /** Submitting plays to ListenBrainz with the user's token, or null when not set up. */
  listenbrainzSubmit: ListenBrainzSubmitView | null;
}

export interface ListenBrainzSubmitView {
  /** The ListenBrainz account the token belongs to. */
  userName: string;
  lastSubmittedAt: string | null;
  /** Plays waiting to be submitted (after a failure, or while ListenBrainz is down). */
  pending: number;
  /** Why the last try failed, in plain words; null when it went through. */
  error: string | null;
}

/** `PUT /account/listenbrainz-token`. The token from ListenBrainz's settings page. */
export interface ListenBrainzTokenRequest {
  token: string;
}

/**
 * `POST /plays`: a track listened to for half its length or 4 minutes
 * (whichever comes first). The server looks up the details in Lidarr.
 */
export interface RecordPlayRequest {
  trackFileId: number;
  /** When it started playing. */
  playedAt: string;
}

/** `GET /plays`: what the user played, most recent first (Now Playing's History). */
export interface PlayedTrack {
  trackFileId: number;
  mimeType: string;
  title: string;
  artistName: string;
  artistMbid: string | null;
  albumTitle: string;
  albumMbid: string | null;
  coverUrl: string | null;
  durationMs: number | null;
  playedAt: string;
}

/**
 * `PUT /account/listening`. Omit a field to leave it as is; send null or an
 * empty string to clear it. Each name is checked with its service first.
 */
export interface UpdateListeningRequest {
  lastfmUsername?: string | null;
  listenbrainzUsername?: string | null;
}
