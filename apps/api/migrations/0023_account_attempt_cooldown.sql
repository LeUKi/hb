CREATE TABLE `account_attempt_cooldowns` (
	`user_id` text PRIMARY KEY NOT NULL,
	`revision` integer NOT NULL,
	`origin` text NOT NULL,
	`attempt_id` text NOT NULL,
	`accepted_at` integer NOT NULL,
	`next_allowed_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `attempt_rate_limit_changes` (
	`id` text PRIMARY KEY NOT NULL,
	`actor_user_id` text NOT NULL,
	`previous_version` integer NOT NULL,
	`next_version` integer NOT NULL,
	`previous_home_interval_seconds` integer NOT NULL,
	`home_interval_seconds` integer NOT NULL,
	`previous_activity_interval_seconds` integer NOT NULL,
	`activity_interval_seconds` integer NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `attempt_rate_limit_changes_time_idx` ON `attempt_rate_limit_changes` (`created_at`,`id`);--> statement-breakpoint
CREATE TABLE `attempt_rate_limits` (
	`id` text PRIMARY KEY NOT NULL,
	`version` integer NOT NULL,
	`home_interval_seconds` integer NOT NULL,
	`activity_interval_seconds` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`updated_by_user_id` text
);
--> statement-breakpoint
ALTER TABLE `global_redemptions` ADD `selected_activity_id` text;
--> statement-breakpoint
INSERT INTO attempt_rate_limits
  (id, version, home_interval_seconds, activity_interval_seconds, updated_at)
VALUES ('global', 1, 5, 2, CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER));
--> statement-breakpoint
-- Preserve a legacy server-created child submission that already reached D1.
UPDATE global_redemptions SET selected_activity_id = (
  SELECT s.activity_id FROM redemption_submissions s
  WHERE s.user_id = global_redemptions.user_id
    AND s.submission_id = global_redemptions.claim_submission_id
    AND s.purpose IN ('claim', 'register')
)
WHERE EXISTS (
  SELECT 1 FROM redemption_submissions s
  WHERE s.user_id = global_redemptions.user_id
    AND s.submission_id = global_redemptions.claim_submission_id
    AND s.purpose IN ('claim', 'register')
);
