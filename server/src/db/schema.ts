import { sql } from 'drizzle-orm';
import { index, integer, primaryKey, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

/** Settings edited in the UI. `value` is JSON, or ciphertext when `encrypted` is set. */
export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  encrypted: integer('encrypted', { mode: 'boolean' }).notNull().default(false),
  updatedAt: integer('updated_at', { mode: 'timestamp' })
    .notNull()
    .default(sql`(unixepoch())`),
});

export const users = sqliteTable('users', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  /** Unique regardless of case; see the migration's `COLLATE NOCASE`. */
  username: text('username').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  role: text('role', { enum: ['admin', 'user'] }).notNull().default('user'),
  /** JSON array of permission names; admins implicitly have all of them. */
  permissions: text('permissions').notNull().default('[]'),
  lastfmUsername: text('lastfm_username'),
  listenbrainzUsername: text('listenbrainz_username'),
  /** Last request with a valid session (updated at most every few minutes); null until they first sign in. */
  lastSeenAt: integer('last_seen_at', { mode: 'timestamp' }),
  /** Set by an admin adding the user or resetting their password: they choose their own at next sign-in. */
  mustChangePassword: integer('must_change_password', { mode: 'boolean' }).notNull().default(false),
  /** A temporary password stops working after this (an unused invite should not stay valid forever). */
  temporaryPasswordExpiresAt: integer('temporary_password_expires_at', { mode: 'timestamp' }),
  /** JSON DiscoverPreferences (default mode, section order); `{}` means the defaults. */
  discoverPrefs: text('discover_prefs').notNull().default('{}'),
  createdAt: integer('created_at', { mode: 'timestamp' })
    .notNull()
    .default(sql`(unixepoch())`),
});

/**
 * Cached copy of Lidarr's artist list, so the Library renders instantly and
 * survives Lidarr being down. Replaced wholesale on each sync.
 */
export const libraryArtists = sqliteTable(
  'library_artists',
  {
    lidarrId: integer('lidarr_id').primaryKey(),
    mbid: text('mbid').notNull(),
    name: text('name').notNull(),
    /** Lidarr's sort name, so "The Cure" sorts under C. */
    sortName: text('sort_name').notNull(),
    monitored: integer('monitored', { mode: 'boolean' }).notNull(),
    addedAt: integer('added_at', { mode: 'timestamp' }).notNull(),
    albumCount: integer('album_count').notNull().default(0),
    trackCount: integer('track_count').notNull().default(0),
    trackFileCount: integer('track_file_count').notNull().default(0),
    sizeOnDisk: integer('size_on_disk').notNull().default(0),
    /** Monitored albums with no files, from Lidarr's wanted/missing list. */
    missingAlbums: integer('missing_albums').notNull().default(0),
    genres: text('genres').notNull().default('[]'),
    /** Lidarr MediaCover path, including its lastWrite stamp. Needs the API key to fetch. */
    imagePath: text('image_path'),
    /** Public fallback (fanart.tv and similar) when Lidarr has no local copy. */
    imageRemoteUrl: text('image_remote_url'),
  },
  (table) => [index('library_artists_mbid_idx').on(table.mbid)],
);

/** Last run of each background job, for status display and staleness checks. */
export const jobs = sqliteTable('jobs', {
  name: text('name').primaryKey(),
  lastRunAt: integer('last_run_at', { mode: 'timestamp' }),
  lastSuccessAt: integer('last_success_at', { mode: 'timestamp' }),
  error: text('error'),
});

/**
 * MusicBrainz responses, keyed by request path. MusicBrainz allows one
 * request per second, so everything is cached and served stale on failure.
 */
export const musicbrainzCache = sqliteTable('musicbrainz_cache', {
  path: text('path').primaryKey(),
  body: text('body').notNull(),
  fetchedAt: integer('fetched_at', { mode: 'timestamp' }).notNull(),
});

/** Who asked Offbeat to add what, so Lidarr adds can be attributed to users. */
export const requests = sqliteTable(
  'requests',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    userId: integer('user_id').references(() => users.id, { onDelete: 'set null' }),
    /** Who asked, as their username then, so the request stays attributed after the user is removed. */
    requestedBy: text('requested_by'),
    artistMbid: text('artist_mbid').notNull(),
    albumMbid: text('album_mbid'),
    lidarrArtistId: integer('lidarr_artist_id'),
    lidarrAlbumId: integer('lidarr_album_id'),
    createdAt: integer('created_at', { mode: 'timestamp' })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (table) => [index('requests_user_id_idx').on(table.userId)],
);

/** Login sessions. `id` is the SHA-256 of the cookie token, so a leaked database cannot be replayed. */
export const sessions = sqliteTable(
  'sessions',
  {
    id: text('id').primaryKey(),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdAt: integer('created_at', { mode: 'timestamp' })
      .notNull()
      .default(sql`(unixepoch())`),
    expiresAt: integer('expires_at', { mode: 'timestamp' }).notNull(),
  },
  (table) => [index('sessions_user_id_idx').on(table.userId)],
);

/**
 * Upstream data for discovery (similar artists, popularity, tags, listening
 * stats, Lidarr lookups), keyed by source and request. Served stale when a
 * source is down, and refreshed after a per-kind age.
 */
export const sourceCache = sqliteTable('source_cache', {
  key: text('key').primaryKey(),
  body: text('body').notNull(),
  fetchedAt: integer('fetched_at', { mode: 'timestamp' }).notNull(),
});

/** Each user's latest recommendations per mode, so Discover renders instantly. */
export const recommendations = sqliteTable(
  'recommendations',
  {
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    mode: text('mode', { enum: ['safer', 'balanced', 'deeper'] }).notNull(),
    /** JSON: the recommendation list and how it was made. */
    payload: text('payload').notNull(),
    generatedAt: integer('generated_at', { mode: 'timestamp' }).notNull(),
  },
  (table) => [primaryKey({ columns: [table.userId, table.mode] })],
);

/**
 * Thumbs up or down on a recommended artist. Its genres at the time feed the
 * user's tag weights; a thumbs down also keeps the artist out of future picks.
 */
export const feedback = sqliteTable(
  'feedback',
  {
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    artistMbid: text('artist_mbid').notNull(),
    /** The artist's name when rated, for the Hidden list in Settings, Discovery. */
    name: text('name').notNull().default(''),
    /** 1 for thumbs up, -1 for thumbs down. */
    value: integer('value').notNull(),
    /** JSON array of the artist's genres when rated. */
    genres: text('genres').notNull().default('[]'),
    createdAt: integer('created_at', { mode: 'timestamp' })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (table) => [primaryKey({ columns: [table.userId, table.artistMbid] })],
);

/** Artists and tags a user never wants recommended. */
export const blocklist = sqliteTable(
  'blocklist',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    kind: text('kind', { enum: ['artist', 'tag'] }).notNull(),
    /** The artist's MBID, or the tag in lower case. */
    key: text('key').notNull(),
    /** What to show: the artist's name, or the tag as written. */
    name: text('name').notNull(),
    /** Where it was blocked from: discover, search, or settings. */
    source: text('source', { enum: ['discover', 'search', 'settings', 'tag'] }).notNull(),
    createdAt: integer('created_at', { mode: 'timestamp' })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (table) => [uniqueIndex('blocklist_user_kind_key').on(table.userId, table.kind, table.key)],
);

/** Recent notification deliveries (Settings, Notifications). Only the latest few hundred are kept. */
export const deliveries = sqliteTable(
  'deliveries',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    channel: text('channel', { enum: ['discord', 'webhook'] }).notNull(),
    event: text('event').notNull(),
    title: text('title').notNull(),
    message: text('message').notNull(),
    status: text('status', { enum: ['delivered', 'retrying', 'failed'] }).notNull(),
    attempts: integer('attempts').notNull().default(0),
    error: text('error'),
    createdAt: integer('created_at', { mode: 'timestamp' })
      .notNull()
      .default(sql`(unixepoch())`),
    updatedAt: integer('updated_at', { mode: 'timestamp' })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (table) => [index('deliveries_created_idx').on(table.createdAt)],
);

/**
 * What each user played in Offbeat, for Discover seeds, Now Playing's
 * History, and ListenBrainz. Recorded once a track has been listened to for
 * half its length or 4 minutes; details come from Lidarr, not the browser.
 */
export const plays = sqliteTable(
  'plays',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    trackFileId: integer('track_file_id').notNull(),
    title: text('title').notNull(),
    artistName: text('artist_name').notNull(),
    artistMbid: text('artist_mbid'),
    albumTitle: text('album_title').notNull(),
    /** Release group MBID. */
    albumMbid: text('album_mbid'),
    recordingMbid: text('recording_mbid'),
    durationMs: integer('duration_ms'),
    mimeType: text('mime_type').notNull(),
    playedAt: integer('played_at', { mode: 'timestamp' }).notNull(),
    /** When ListenBrainz accepted it; null when not submitted (or not yet). */
    listenbrainzAt: integer('listenbrainz_at', { mode: 'timestamp' }),
  },
  (table) => [index('plays_user_played_idx').on(table.userId, table.playedAt)],
);
