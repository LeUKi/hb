CREATE TABLE `login_setting_changes` (
	`id` text PRIMARY KEY NOT NULL,
	`actor_user_id` text NOT NULL,
	`previous_version` integer NOT NULL,
	`next_version` integer NOT NULL,
	`previous_liteauth_enabled` integer NOT NULL,
	`liteauth_enabled` integer NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `login_setting_changes_version_unique` ON `login_setting_changes` (`next_version`);--> statement-breakpoint
CREATE TABLE `login_settings` (
	`id` text PRIMARY KEY NOT NULL,
	`version` integer NOT NULL,
	`liteauth_enabled` integer DEFAULT true NOT NULL,
	`updated_at` integer NOT NULL,
	`updated_by_user_id` text
);
--> statement-breakpoint
INSERT INTO login_settings (id, version, liteauth_enabled, updated_at)
VALUES ('global', 1, 1, CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER));
