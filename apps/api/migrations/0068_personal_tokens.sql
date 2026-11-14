CREATE TABLE `personal_tokens` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`token_hash` text NOT NULL,
	`last_four` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`last_used_at` integer,
	`last_used_ip` text,
	`use_count` integer DEFAULT 0 NOT NULL,
	`revoked_at` integer,
	`revoked_by_user_id` text,
	`revoke_reason` text,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`revoked_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "personal_tokens_valid" CHECK(length("personal_tokens"."name") BETWEEN 1 AND 20 AND length("personal_tokens"."last_four") = 4
        AND "personal_tokens"."expires_at" > "personal_tokens"."created_at" AND "personal_tokens"."use_count" >= 0
        AND ("personal_tokens"."revoked_at" IS NOT NULL OR ("personal_tokens"."revoked_by_user_id" IS NULL AND "personal_tokens"."revoke_reason" IS NULL))
        AND ("personal_tokens"."revoked_by_user_id" IS NULL OR length("personal_tokens"."revoke_reason") BETWEEN 1 AND 200))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `personal_tokens_token_unique` ON `personal_tokens` (`token_hash`);--> statement-breakpoint
CREATE INDEX `personal_tokens_user_idx` ON `personal_tokens` (`user_id`,`created_at`);
--> statement-breakpoint
-- A personal token: whose it is, its digest and its lifetime never change, a
-- stop is final, and its use count only grows.
CREATE TRIGGER personal_tokens_immutable
BEFORE UPDATE ON personal_tokens
WHEN NEW.id IS NOT OLD.id OR NEW.user_id IS NOT OLD.user_id OR NEW.token_hash IS NOT OLD.token_hash
  OR NEW.last_four IS NOT OLD.last_four OR NEW.created_at IS NOT OLD.created_at
  OR NEW.expires_at IS NOT OLD.expires_at OR NEW.use_count < OLD.use_count
  OR (OLD.revoked_at IS NOT NULL AND (NEW.revoked_at IS NOT OLD.revoked_at
    OR NEW.revoked_by_user_id IS NOT OLD.revoked_by_user_id OR NEW.revoke_reason IS NOT OLD.revoke_reason))
BEGIN
  SELECT RAISE(ABORT, 'personal token only winds down');
END;--> statement-breakpoint
CREATE TRIGGER personal_tokens_permanent
BEFORE DELETE ON personal_tokens
BEGIN
  SELECT RAISE(ABORT, 'personal tokens are permanent');
END;
