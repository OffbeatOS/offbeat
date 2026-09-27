CREATE TABLE `jobs` (
	`name` text PRIMARY KEY NOT NULL,
	`last_run_at` integer,
	`last_success_at` integer,
	`error` text
);
--> statement-breakpoint
CREATE TABLE `library_artists` (
	`lidarr_id` integer PRIMARY KEY NOT NULL,
	`mbid` text NOT NULL,
	`name` text NOT NULL,
	`sort_name` text NOT NULL,
	`monitored` integer NOT NULL,
	`added_at` integer NOT NULL,
	`album_count` integer DEFAULT 0 NOT NULL,
	`track_count` integer DEFAULT 0 NOT NULL,
	`track_file_count` integer DEFAULT 0 NOT NULL,
	`size_on_disk` integer DEFAULT 0 NOT NULL,
	`missing_albums` integer DEFAULT 0 NOT NULL,
	`genres` text DEFAULT '[]' NOT NULL,
	`image_path` text,
	`image_remote_url` text
);
--> statement-breakpoint
CREATE INDEX `library_artists_mbid_idx` ON `library_artists` (`mbid`);