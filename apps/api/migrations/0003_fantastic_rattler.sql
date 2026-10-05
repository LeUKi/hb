CREATE TABLE `global_redemptions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`submission_id` text NOT NULL,
	`fingerprint` text NOT NULL,
	`password_digest` text NOT NULL,
	`candidate_ids` text NOT NULL,
	`claim_submission_id` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `global_redemptions_user_submission_unique` ON `global_redemptions` (`user_id`,`submission_id`);--> statement-breakpoint
CREATE INDEX `global_redemptions_user_time_idx` ON `global_redemptions` (`user_id`,`created_at`);--> statement-breakpoint
ALTER TABLE `activities` ADD `join_square` integer DEFAULT false NOT NULL;