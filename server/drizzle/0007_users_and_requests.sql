ALTER TABLE `requests` ADD `requested_by` text;--> statement-breakpoint
ALTER TABLE `users` ADD `last_seen_at` integer;--> statement-breakpoint
ALTER TABLE `users` ADD `must_change_password` integer DEFAULT false NOT NULL;--> statement-breakpoint
UPDATE `requests` SET `requested_by` = (SELECT `username` FROM `users` WHERE `users`.`id` = `requests`.`user_id`) WHERE `user_id` IS NOT NULL;--> statement-breakpoint
UPDATE `users` SET `last_seen_at` = (SELECT MAX(`created_at`) FROM `sessions` WHERE `sessions`.`user_id` = `users`.`id`);