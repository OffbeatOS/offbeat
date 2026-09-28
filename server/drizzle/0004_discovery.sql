CREATE TABLE `recommendations` (
	`user_id` integer NOT NULL,
	`mode` text NOT NULL,
	`payload` text NOT NULL,
	`generated_at` integer NOT NULL,
	PRIMARY KEY(`user_id`, `mode`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `source_cache` (
	`key` text PRIMARY KEY NOT NULL,
	`body` text NOT NULL,
	`fetched_at` integer NOT NULL
);
