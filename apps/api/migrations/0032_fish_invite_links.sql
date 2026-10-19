PRAGMA defer_foreign_keys=ON;--> statement-breakpoint
-- It reads balance_invites, which is rebuilt below.
DROP TRIGGER balance_members_insert_valid;--> statement-breakpoint
CREATE TABLE `__new_balance_invites` (
	`id` text PRIMARY KEY NOT NULL,
	`token_hash` text NOT NULL,
	`inviter_user_id` text NOT NULL,
	`invitee_username` text,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`accepted_at` integer,
	`accepted_user_id` text,
	`max_uses` integer,
	`use_count` integer DEFAULT 0 NOT NULL,
	`stopped_at` integer,
	`stopped_by_user_id` text,
	FOREIGN KEY (`inviter_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`accepted_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`stopped_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "balance_invites_valid" CHECK("__new_balance_invites"."expires_at" > "__new_balance_invites"."created_at" AND length("__new_balance_invites"."token_hash") = 64
        AND ("__new_balance_invites"."invitee_username" IS NULL OR ("__new_balance_invites"."invitee_username" = lower("__new_balance_invites"."invitee_username") AND length("__new_balance_invites"."invitee_username") BETWEEN 1 AND 60))
        AND ("__new_balance_invites"."accepted_at" IS NULL) = ("__new_balance_invites"."accepted_user_id" IS NULL)
        AND ("__new_balance_invites"."invitee_username" IS NULL) = ("__new_balance_invites"."max_uses" IS NOT NULL)
        AND ("__new_balance_invites"."max_uses" IS NULL OR ("__new_balance_invites"."max_uses" BETWEEN 1 AND 1000 AND "__new_balance_invites"."accepted_at" IS NULL))
        AND "__new_balance_invites"."use_count" BETWEEN 0 AND coalesce("__new_balance_invites"."max_uses", 0)
        AND ("__new_balance_invites"."stopped_at" IS NULL) = ("__new_balance_invites"."stopped_by_user_id" IS NULL)
        AND ("__new_balance_invites"."stopped_at" IS NULL OR "__new_balance_invites"."max_uses" IS NOT NULL))
);
--> statement-breakpoint
INSERT INTO `__new_balance_invites`("id", "token_hash", "inviter_user_id", "invitee_username", "created_at", "expires_at", "accepted_at", "accepted_user_id", "max_uses", "use_count", "stopped_at", "stopped_by_user_id") SELECT "id", "token_hash", "inviter_user_id", "invitee_username", "created_at", "expires_at", "accepted_at", "accepted_user_id", NULL, 0, NULL, NULL FROM `balance_invites`;--> statement-breakpoint
DROP TABLE `balance_invites`;--> statement-breakpoint
ALTER TABLE `__new_balance_invites` RENAME TO `balance_invites`;--> statement-breakpoint
CREATE UNIQUE INDEX `balance_invites_token_unique` ON `balance_invites` (`token_hash`);--> statement-breakpoint
CREATE INDEX `balance_invites_inviter_time_idx` ON `balance_invites` (`inviter_user_id`,`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `balance_invites_time_idx` ON `balance_invites` (`created_at`,`id`);--> statement-breakpoint
DROP INDEX `balance_members_invite_unique`;--> statement-breakpoint
CREATE INDEX `balance_members_invite_idx` ON `balance_members` (`invite_id`);--> statement-breakpoint
-- An invitation is fixed when made. One for a username is accepted once,
-- in time, by the account it names (not by its sender); a 通用链接 counts
-- one more use while it is open, or is stopped, once. Neither is removed.
CREATE TRIGGER balance_invites_insert_valid
BEFORE INSERT ON balance_invites
WHEN NEW.accepted_at IS NOT NULL OR NEW.accepted_user_id IS NOT NULL OR NEW.use_count <> 0 OR NEW.stopped_at IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'invite starts unused');
END;--> statement-breakpoint
CREATE TRIGGER balance_invites_immutable
BEFORE UPDATE ON balance_invites
WHEN NEW.id IS NOT OLD.id OR NEW.token_hash IS NOT OLD.token_hash OR NEW.inviter_user_id IS NOT OLD.inviter_user_id
  OR NEW.invitee_username IS NOT OLD.invitee_username OR NEW.created_at IS NOT OLD.created_at
  OR NEW.expires_at IS NOT OLD.expires_at OR NEW.max_uses IS NOT OLD.max_uses
BEGIN
  SELECT RAISE(ABORT, 'invite fixed when made');
END;--> statement-breakpoint
CREATE TRIGGER balance_invites_accept_valid
BEFORE UPDATE ON balance_invites
WHEN OLD.invitee_username IS NOT NULL AND (
  OLD.accepted_at IS NOT NULL
  OR NEW.accepted_at IS NULL OR NEW.accepted_at >= OLD.expires_at
  OR NEW.accepted_user_id IS OLD.inviter_user_id
  OR NOT EXISTS (SELECT 1 FROM users u WHERE u.id = NEW.accepted_user_id AND lower(u.username) = OLD.invitee_username))
BEGIN
  SELECT RAISE(ABORT, 'invite accepted once, in time, by its own account');
END;--> statement-breakpoint
CREATE TRIGGER balance_invites_link_valid
BEFORE UPDATE ON balance_invites
WHEN OLD.invitee_username IS NULL AND (
  OLD.stopped_at IS NOT NULL
  OR NOT ((NEW.use_count = OLD.use_count + 1 AND NEW.stopped_at IS NULL)
    OR (NEW.use_count = OLD.use_count AND NEW.stopped_at >= OLD.created_at)))
BEGIN
  SELECT RAISE(ABORT, 'link used while open, or stopped once');
END;--> statement-breakpoint
CREATE TRIGGER balance_invites_permanent
BEFORE DELETE ON balance_invites
BEGIN
  SELECT RAISE(ABORT, 'invites are permanent');
END;--> statement-breakpoint
-- 转入 资格: from an invitation its holder accepted. Through a 通用链接,
-- one member for each use counted, in time, while it was not stopped.
CREATE TRIGGER balance_members_insert_valid
BEFORE INSERT ON balance_members
WHEN NEW.invite_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM balance_invites i WHERE i.id = NEW.invite_id AND i.inviter_user_id IS NEW.invited_by_user_id
    AND (i.accepted_user_id = NEW.user_id
      OR (i.invitee_username IS NULL AND i.stopped_at IS NULL AND NEW.created_at < i.expires_at
        AND NEW.user_id <> i.inviter_user_id
        AND (SELECT COUNT(*) FROM balance_members m WHERE m.invite_id = i.id) < i.use_count)))
BEGIN
  SELECT RAISE(ABORT, 'member needs the invite they accepted');
END;--> statement-breakpoint
PRAGMA defer_foreign_keys=OFF;
