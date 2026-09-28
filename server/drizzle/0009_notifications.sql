CREATE TABLE `deliveries` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`channel` text NOT NULL,
	`event` text NOT NULL,
	`title` text NOT NULL,
	`message` text NOT NULL,
	`status` text NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`error` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `deliveries_created_idx` ON `deliveries` (`created_at`);