-- 个人令牌's limits (docs/personal-token-design.md §8): the 站长's switch for
-- every request with a token, on; and each 红包's 允许用令牌领, on for all
-- (its sender turns it off). claims.via and activity_registrations.via take
-- "token" too, a text column already. New table and column only.
CREATE TABLE `personal_token_settings` (
	`id` text PRIMARY KEY NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`updated_by` text,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`updated_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "personal_token_settings_singleton" CHECK("personal_token_settings"."id" = 'global')
);
--> statement-breakpoint
ALTER TABLE `activities` ADD `allow_tokens` integer DEFAULT true NOT NULL;--> statement-breakpoint
INSERT INTO `personal_token_settings` (`id`,`enabled`,`version`,`updated_at`) VALUES ('global',1,1,CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER));
