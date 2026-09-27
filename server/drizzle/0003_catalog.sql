CREATE TABLE `musicbrainz_cache` (
	`path` text PRIMARY KEY NOT NULL,
	`body` text NOT NULL,
	`fetched_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `requests` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer,
	`artist_mbid` text NOT NULL,
	`album_mbid` text,
	`lidarr_artist_id` integer,
	`lidarr_album_id` integer,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `requests_user_id_idx` ON `requests` (`user_id`);