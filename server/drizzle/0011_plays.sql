CREATE TABLE `plays` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer NOT NULL,
	`track_file_id` integer NOT NULL,
	`title` text NOT NULL,
	`artist_name` text NOT NULL,
	`artist_mbid` text,
	`album_title` text NOT NULL,
	`album_mbid` text,
	`recording_mbid` text,
	`duration_ms` integer,
	`mime_type` text NOT NULL,
	`played_at` integer NOT NULL,
	`listenbrainz_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `plays_user_played_idx` ON `plays` (`user_id`,`played_at`);