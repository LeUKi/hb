ALTER TABLE `oauth_attempts` ADD `login_provider` text DEFAULT 'connect' NOT NULL;--> statement-breakpoint
ALTER TABLE `oauth_attempts` ADD `pkce_verifier_ciphertext` text;--> statement-breakpoint
ALTER TABLE `oauth_attempts` ADD `expected_user_id` text;--> statement-breakpoint
ALTER TABLE `sessions` ADD `login_provider` text DEFAULT 'connect' NOT NULL;--> statement-breakpoint
ALTER TABLE `users` ADD `official_connect_verified` integer DEFAULT false NOT NULL;--> statement-breakpoint
-- All existing accounts were created through the official Connect flow.
UPDATE users SET official_connect_verified=1 WHERE provider='linux_do';--> statement-breakpoint
CREATE TRIGGER users_official_connect_monotonic
BEFORE UPDATE OF official_connect_verified ON users
WHEN OLD.official_connect_verified=1 AND NEW.official_connect_verified!=1
BEGIN
  SELECT RAISE(ABORT,'OFFICIAL_CONNECT_CANNOT_DOWNGRADE');
END;--> statement-breakpoint
CREATE TRIGGER users_official_connect_insert_valid
BEFORE INSERT ON users
WHEN NEW.official_connect_verified NOT IN (0,1)
BEGIN
  SELECT RAISE(ABORT,'OFFICIAL_CONNECT_FLAG_INVALID');
END;--> statement-breakpoint
CREATE TRIGGER users_official_connect_update_valid
BEFORE UPDATE OF official_connect_verified ON users
WHEN NEW.official_connect_verified NOT IN (0,1)
BEGIN
  SELECT RAISE(ABORT,'OFFICIAL_CONNECT_FLAG_INVALID');
END;
