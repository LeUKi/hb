CREATE TABLE `balance_invites` (
	`id` text PRIMARY KEY NOT NULL,
	`token_hash` text NOT NULL,
	`inviter_user_id` text NOT NULL,
	`invitee_username` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`accepted_at` integer,
	`accepted_user_id` text,
	FOREIGN KEY (`inviter_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`accepted_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "balance_invites_valid" CHECK("balance_invites"."expires_at" > "balance_invites"."created_at" AND length("balance_invites"."token_hash") = 64
        AND "balance_invites"."invitee_username" = lower("balance_invites"."invitee_username") AND length("balance_invites"."invitee_username") BETWEEN 1 AND 60
        AND ("balance_invites"."accepted_at" IS NULL) = ("balance_invites"."accepted_user_id" IS NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `balance_invites_token_unique` ON `balance_invites` (`token_hash`);--> statement-breakpoint
CREATE INDEX `balance_invites_inviter_time_idx` ON `balance_invites` (`inviter_user_id`,`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `balance_invites_time_idx` ON `balance_invites` (`created_at`,`id`);--> statement-breakpoint
CREATE TABLE `balance_members` (
	`user_id` text PRIMARY KEY NOT NULL,
	`invited_by_user_id` text,
	`invite_id` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`invited_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`invite_id`) REFERENCES `balance_invites`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `balance_members_invite_unique` ON `balance_members` (`invite_id`);--> statement-breakpoint
CREATE INDEX `balance_members_inviter_idx` ON `balance_members` (`invited_by_user_id`);--> statement-breakpoint
PRAGMA defer_foreign_keys=ON;--> statement-breakpoint
CREATE TABLE `__new_balance_settings` (
	`id` text PRIMARY KEY NOT NULL,
	`version` integer NOT NULL,
	`topup_enabled` integer DEFAULT false NOT NULL,
	`withdraw_enabled` integer DEFAULT false NOT NULL,
	`topup_fee_percent` integer DEFAULT 12 NOT NULL,
	`withdraw_fee_percent` integer DEFAULT 12 NOT NULL,
	`withdraw_max_minor` integer DEFAULT 100000 NOT NULL,
	`updated_at` integer NOT NULL,
	`updated_by_user_id` text,
	CONSTRAINT "balance_settings_singleton" CHECK("__new_balance_settings"."id" = 'global'),
	CONSTRAINT "balance_settings_fees_valid" CHECK("__new_balance_settings"."topup_fee_percent" BETWEEN 0 AND 50 AND "__new_balance_settings"."withdraw_fee_percent" BETWEEN 0 AND 50),
	CONSTRAINT "balance_settings_withdraw_max_valid" CHECK("__new_balance_settings"."withdraw_max_minor" >= 100)
);
--> statement-breakpoint
INSERT INTO `__new_balance_settings`("id", "version", "topup_enabled", "withdraw_enabled", "topup_fee_percent", "withdraw_fee_percent", "withdraw_max_minor", "updated_at", "updated_by_user_id") SELECT "id", "version", "topup_enabled", "withdraw_enabled", "topup_fee_percent", "withdraw_fee_percent", "withdraw_max_minor", "updated_at", "updated_by_user_id" FROM `balance_settings`;--> statement-breakpoint
DROP TABLE `balance_settings`;--> statement-breakpoint
ALTER TABLE `__new_balance_settings` RENAME TO `balance_settings`;--> statement-breakpoint
-- An invitation is fixed when made; it is accepted once, in time, by the
-- account it names (not by its sender), and never removed.
CREATE TRIGGER balance_invites_insert_valid
BEFORE INSERT ON balance_invites
WHEN NEW.accepted_at IS NOT NULL OR NEW.accepted_user_id IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'invite starts unaccepted');
END;--> statement-breakpoint
CREATE TRIGGER balance_invites_immutable
BEFORE UPDATE ON balance_invites
WHEN NEW.id IS NOT OLD.id OR NEW.token_hash IS NOT OLD.token_hash OR NEW.inviter_user_id IS NOT OLD.inviter_user_id
  OR NEW.invitee_username IS NOT OLD.invitee_username OR NEW.created_at IS NOT OLD.created_at
  OR NEW.expires_at IS NOT OLD.expires_at
  OR OLD.accepted_at IS NOT NULL
  OR NEW.accepted_at IS NULL OR NEW.accepted_at >= OLD.expires_at
  OR NEW.accepted_user_id IS OLD.inviter_user_id
  OR NOT EXISTS (SELECT 1 FROM users u WHERE u.id = NEW.accepted_user_id AND lower(u.username) = OLD.invitee_username)
BEGIN
  SELECT RAISE(ABORT, 'invite accepted once, in time, by its own account');
END;--> statement-breakpoint
CREATE TRIGGER balance_invites_permanent
BEFORE DELETE ON balance_invites
BEGIN
  SELECT RAISE(ABORT, 'invites are permanent');
END;--> statement-breakpoint
-- 转入 资格: from an invitation its holder accepted, and kept for good.
CREATE TRIGGER balance_members_insert_valid
BEFORE INSERT ON balance_members
WHEN NEW.invite_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM balance_invites i WHERE i.id = NEW.invite_id AND i.accepted_user_id = NEW.user_id
    AND i.inviter_user_id IS NEW.invited_by_user_id)
BEGIN
  SELECT RAISE(ABORT, 'member needs the invite they accepted');
END;--> statement-breakpoint
CREATE TRIGGER balance_members_immutable
BEFORE UPDATE ON balance_members
BEGIN
  SELECT RAISE(ABORT, 'members are kept as they are');
END;--> statement-breakpoint
CREATE TRIGGER balance_members_permanent
BEFORE DELETE ON balance_members
BEGIN
  SELECT RAISE(ABORT, 'members are kept for good');
END;--> statement-breakpoint
PRAGMA defer_foreign_keys=OFF;
