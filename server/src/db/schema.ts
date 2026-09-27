import { sql } from 'drizzle-orm';
import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

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
