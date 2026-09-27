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
}

/**
 * `PUT /account/listening`. Omit a field to leave it as is; send null or an
 * empty string to clear it. Each name is checked with its service first.
 */
export interface UpdateListeningRequest {
  lastfmUsername?: string | null;
  listenbrainzUsername?: string | null;
}
