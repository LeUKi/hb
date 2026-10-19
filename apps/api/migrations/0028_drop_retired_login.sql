DROP TABLE `login_setting_changes`;--> statement-breakpoint
DROP TABLE `login_settings`;--> statement-breakpoint
ALTER TABLE `oauth_attempts` DROP COLUMN `login_provider`;--> statement-breakpoint
ALTER TABLE `oauth_attempts` DROP COLUMN `pkce_verifier_ciphertext`;--> statement-breakpoint
ALTER TABLE `oauth_attempts` DROP COLUMN `expected_user_id`;--> statement-breakpoint
ALTER TABLE `sessions` DROP COLUMN `login_provider`;--> statement-breakpoint
ALTER TABLE `users` DROP COLUMN `official_connect_verified`;