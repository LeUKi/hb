CREATE TABLE `attempt_events` (
	`id` text PRIMARY KEY NOT NULL,
	`submission_row_id` text NOT NULL,
	`activity_id` text NOT NULL,
	`user_id` text NOT NULL,
	`ciphertext` text NOT NULL,
	`digest` text NOT NULL,
	`matched` integer NOT NULL,
	`matched_password_id` text,
	`validated_at` integer NOT NULL,
	`claim_id` text,
	FOREIGN KEY (`submission_row_id`) REFERENCES `redemption_submissions`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`activity_id`) REFERENCES `activities`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`matched_password_id`) REFERENCES `activity_passwords`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`claim_id`) REFERENCES `claims`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `attempt_events_submission_unique` ON `attempt_events` (`submission_row_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `attempt_events_claim_unique` ON `attempt_events` (`claim_id`);--> statement-breakpoint
CREATE INDEX `attempt_events_activity_digest_idx` ON `attempt_events` (`activity_id`,`digest`);--> statement-breakpoint
CREATE INDEX `attempt_events_activity_user_idx` ON `attempt_events` (`activity_id`,`user_id`);--> statement-breakpoint
CREATE TABLE `claims` (
	`id` text PRIMARY KEY NOT NULL,
	`activity_id` text NOT NULL,
	`user_id` text NOT NULL,
	`inventory_id` text NOT NULL,
	`password_id` text NOT NULL,
	`claimed_at` integer NOT NULL,
	FOREIGN KEY (`activity_id`) REFERENCES `activities`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`password_id`) REFERENCES `activity_passwords`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`activity_id`,`inventory_id`) REFERENCES `text_inventory`(`activity_id`,`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `claims_activity_user_unique` ON `claims` (`activity_id`,`user_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `claims_activity_inventory_unique` ON `claims` (`activity_id`,`inventory_id`);--> statement-breakpoint
CREATE INDEX `claims_user_time_idx` ON `claims` (`user_id`,`claimed_at`,`id`);--> statement-breakpoint
CREATE INDEX `claims_activity_time_idx` ON `claims` (`activity_id`,`claimed_at`,`id`);--> statement-breakpoint
CREATE TABLE `redemption_submissions` (
	`id` text PRIMARY KEY NOT NULL,
	`activity_id` text NOT NULL,
	`user_id` text NOT NULL,
	`submission_id` text NOT NULL,
	`fingerprint` text NOT NULL,
	`outcome` text NOT NULL,
	`matched_password_id` text,
	`claim_id` text,
	`created_at` integer NOT NULL,
	`validated_at` integer,
	`finished_at` integer,
	FOREIGN KEY (`activity_id`) REFERENCES `activities`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`matched_password_id`) REFERENCES `activity_passwords`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`claim_id`) REFERENCES `claims`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `redemption_submissions_user_key_unique` ON `redemption_submissions` (`user_id`,`submission_id`);--> statement-breakpoint
CREATE INDEX `redemption_submissions_rate_idx` ON `redemption_submissions` (`activity_id`,`user_id`,`validated_at`);--> statement-breakpoint
CREATE INDEX `redemption_submissions_pending_idx` ON `redemption_submissions` (`outcome`,`activity_id`,`created_at`,`id`);--> statement-breakpoint
ALTER TABLE `activities` ADD `end_reason` text;--> statement-breakpoint
ALTER TABLE `activities` ADD `archived_at` integer;