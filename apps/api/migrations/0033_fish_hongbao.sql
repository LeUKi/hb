PRAGMA defer_foreign_keys=ON;--> statement-breakpoint
CREATE TABLE `__new_balance_entries` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`kind` text NOT NULL,
	`available_delta_minor` integer NOT NULL,
	`locked_delta_minor` integer DEFAULT 0 NOT NULL,
	`topup_id` text,
	`adjustment_id` text,
	`lock_id` text,
	`claim_id` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`topup_id`) REFERENCES `balance_topups`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`adjustment_id`) REFERENCES `balance_adjustments`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`claim_id`) REFERENCES `claims`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "balance_entries_shape_valid" CHECK(("__new_balance_entries"."kind" = 'topup' AND "__new_balance_entries"."topup_id" IS NOT NULL AND "__new_balance_entries"."available_delta_minor" > 0 AND "__new_balance_entries"."locked_delta_minor" = 0 AND "__new_balance_entries"."claim_id" IS NULL)
        OR ("__new_balance_entries"."kind" = 'adjustment' AND "__new_balance_entries"."adjustment_id" IS NOT NULL AND "__new_balance_entries"."available_delta_minor" != 0 AND "__new_balance_entries"."locked_delta_minor" = 0 AND "__new_balance_entries"."claim_id" IS NULL)
        OR ("__new_balance_entries"."kind" = 'lock' AND "__new_balance_entries"."lock_id" IS NOT NULL AND "__new_balance_entries"."available_delta_minor" < 0 AND "__new_balance_entries"."locked_delta_minor" = -"__new_balance_entries"."available_delta_minor" AND "__new_balance_entries"."claim_id" IS NULL)
        OR ("__new_balance_entries"."kind" = 'unlock' AND "__new_balance_entries"."lock_id" IS NOT NULL AND "__new_balance_entries"."available_delta_minor" > 0 AND "__new_balance_entries"."locked_delta_minor" = -"__new_balance_entries"."available_delta_minor" AND "__new_balance_entries"."claim_id" IS NULL)
        OR ("__new_balance_entries"."kind" = 'deduct' AND "__new_balance_entries"."lock_id" IS NOT NULL AND "__new_balance_entries"."available_delta_minor" = 0 AND "__new_balance_entries"."locked_delta_minor" < 0)
        OR ("__new_balance_entries"."kind" = 'hongbao' AND "__new_balance_entries"."lock_id" IS NOT NULL AND "__new_balance_entries"."claim_id" IS NOT NULL AND "__new_balance_entries"."available_delta_minor" > 0 AND "__new_balance_entries"."locked_delta_minor" = 0))
);
--> statement-breakpoint
INSERT INTO `__new_balance_entries`("id", "user_id", "kind", "available_delta_minor", "locked_delta_minor", "topup_id", "adjustment_id", "lock_id", "claim_id", "created_at") SELECT "id", "user_id", "kind", "available_delta_minor", "locked_delta_minor", "topup_id", "adjustment_id", "lock_id", NULL, "created_at" FROM `balance_entries`;--> statement-breakpoint
DROP TABLE `balance_entries`;--> statement-breakpoint
ALTER TABLE `__new_balance_entries` RENAME TO `balance_entries`;--> statement-breakpoint
CREATE UNIQUE INDEX `balance_entries_topup_unique` ON `balance_entries` (`topup_id`) WHERE "balance_entries"."kind" = 'topup';--> statement-breakpoint
CREATE UNIQUE INDEX `balance_entries_adjustment_unique` ON `balance_entries` (`adjustment_id`) WHERE "balance_entries"."kind" = 'adjustment';--> statement-breakpoint
CREATE UNIQUE INDEX `balance_entries_lock_unique` ON `balance_entries` (`lock_id`) WHERE "balance_entries"."kind" = 'lock';--> statement-breakpoint
CREATE UNIQUE INDEX `balance_entries_unlock_unique` ON `balance_entries` (`lock_id`) WHERE "balance_entries"."kind" = 'unlock';--> statement-breakpoint
CREATE UNIQUE INDEX `balance_entries_claim_deduct_unique` ON `balance_entries` (`claim_id`) WHERE "balance_entries"."kind" = 'deduct' AND "balance_entries"."claim_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `balance_entries_claim_hongbao_unique` ON `balance_entries` (`claim_id`) WHERE "balance_entries"."kind" = 'hongbao';--> statement-breakpoint
CREATE INDEX `balance_entries_user_time_idx` ON `balance_entries` (`user_id`,`created_at`,`id`);--> statement-breakpoint
ALTER TABLE `activities` ADD `funding` text DEFAULT 'merchant' NOT NULL;--> statement-breakpoint
ALTER TABLE `balance_settings` ADD `hongbao_enabled` integer DEFAULT false NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `balance_locks_activity_unique` ON `balance_locks` (`activity_id`);--> statement-breakpoint
-- The 🐟额 entries' triggers, as 0029 and 0030 made them (the rebuild drops
-- them), with a lock's entries knowing 🐟额红包 (docs/balance-design.md §14).
CREATE TRIGGER balance_entries_no_replace
BEFORE INSERT ON balance_entries
WHEN EXISTS (SELECT 1 FROM balance_entries WHERE id = NEW.id)
BEGIN
  SELECT RAISE(ABORT, 'balance entry exists');
END;--> statement-breakpoint
CREATE TRIGGER balance_entries_available_guard
BEFORE INSERT ON balance_entries
WHEN NEW.kind != 'adjustment' AND NEW.available_delta_minor < 0
  AND COALESCE((SELECT available_minor FROM balance_accounts WHERE user_id = NEW.user_id), 0) + NEW.available_delta_minor < 0
BEGIN
  SELECT RAISE(ABORT, 'BALANCE_INSUFFICIENT');
END;--> statement-breakpoint
CREATE TRIGGER balance_entries_apply
AFTER INSERT ON balance_entries
BEGIN
  INSERT OR IGNORE INTO balance_accounts (user_id, available_minor, locked_minor, updated_at)
  VALUES (NEW.user_id, 0, 0, NEW.created_at);
  UPDATE balance_accounts
  SET available_minor = available_minor + NEW.available_delta_minor,
    locked_minor = locked_minor + NEW.locked_delta_minor,
    updated_at = NEW.created_at
  WHERE user_id = NEW.user_id;
END;--> statement-breakpoint
CREATE TRIGGER balance_entries_immutable
BEFORE UPDATE ON balance_entries
BEGIN
  SELECT RAISE(ABORT, 'balance entries are append-only');
END;--> statement-breakpoint
CREATE TRIGGER balance_entries_permanent
BEFORE DELETE ON balance_entries
BEGIN
  SELECT RAISE(ABORT, 'balance entries are append-only');
END;--> statement-breakpoint
-- A lock's entries: made for its whole amount, given back whole, or taken
-- in parts no larger than what it still holds; each moves the lock too. A
-- 🐟额红包's lock gives back only once the 红包 has ended (a draw: once its
-- prizes are out), and gives up exactly one claim's share at a time.
CREATE TRIGGER balance_entries_lock_guard
BEFORE INSERT ON balance_entries
WHEN NEW.kind IN ('lock','unlock','deduct') AND NOT EXISTS (
  SELECT 1 FROM balance_locks l WHERE l.id=NEW.lock_id AND l.user_id=NEW.user_id AND l.status='active'
    AND ((NEW.kind='lock' AND l.remaining_minor=l.amount_minor AND NEW.locked_delta_minor=l.amount_minor)
      OR (NEW.kind='unlock' AND -NEW.locked_delta_minor=l.remaining_minor
        AND (l.purpose='withdrawal' OR EXISTS (SELECT 1 FROM activities a WHERE a.id=l.activity_id
          AND a.ended_at IS NOT NULL AND (a.draw_state IS NULL OR a.draw_state IN ('completed','empty')))))
      OR (NEW.kind='deduct' AND -NEW.locked_delta_minor<=l.remaining_minor
        AND ((l.purpose='withdrawal' AND NEW.claim_id IS NULL)
          OR (l.purpose='activity' AND EXISTS (SELECT 1 FROM claims c JOIN reward_inventory r ON r.id=c.inventory_id
            WHERE c.id=NEW.claim_id AND c.activity_id=l.activity_id AND r.amount_minor=-NEW.locked_delta_minor))))))
BEGIN
  SELECT RAISE(ABORT, 'balance lock entry mismatch');
END;--> statement-breakpoint
CREATE TRIGGER balance_entries_lock_apply
AFTER INSERT ON balance_entries
WHEN NEW.kind IN ('unlock','deduct')
BEGIN
  UPDATE balance_locks
  SET remaining_minor = remaining_minor + NEW.locked_delta_minor,
    status = CASE WHEN NEW.kind='unlock' THEN 'released'
      WHEN remaining_minor + NEW.locked_delta_minor = 0 THEN 'spent' ELSE status END,
    updated_at = NEW.created_at
  WHERE id = NEW.lock_id;
END;--> statement-breakpoint
-- A 🐟额红包's share reaches its claimant only after the same share left
-- the 红包's lock for that claim.
CREATE TRIGGER balance_entries_hongbao_guard
BEFORE INSERT ON balance_entries
WHEN NEW.kind='hongbao' AND NOT EXISTS (
  SELECT 1 FROM balance_entries d JOIN balance_locks l ON l.id=d.lock_id JOIN claims c ON c.id=d.claim_id
  WHERE d.kind='deduct' AND d.claim_id=NEW.claim_id AND d.lock_id=NEW.lock_id
    AND -d.locked_delta_minor=NEW.available_delta_minor AND l.purpose='activity'
    AND c.user_id=NEW.user_id AND c.activity_id=l.activity_id)
BEGIN
  SELECT RAISE(ABORT, 'hongbao entry needs its deduct');
END;--> statement-breakpoint
-- A 🐟额红包 holds its author's 🐟 from when it opens: one lock, theirs.
CREATE TRIGGER balance_locks_activity_valid
BEFORE INSERT ON balance_locks
WHEN NEW.purpose='activity' AND NOT EXISTS (
  SELECT 1 FROM activities a WHERE a.id=NEW.activity_id AND a.funding='balance'
    AND a.author_id=NEW.user_id AND a.opened_at IS NOT NULL AND a.ended_at IS NULL)
BEGIN
  SELECT RAISE(ABORT, 'activity lock needs its open balance hongbao');
END;--> statement-breakpoint
-- 商户直发 or 🐟额 (no merchant), fixed once the 红包 opens.
CREATE TRIGGER activities_funding_insert_valid
BEFORE INSERT ON activities
WHEN NEW.funding NOT IN ('merchant','balance')
  OR (NEW.funding='balance' AND (NEW.merchant_id IS NOT NULL OR NEW.reward_type!='ldc'))
BEGIN
  SELECT RAISE(ABORT, 'activity funding invalid');
END;--> statement-breakpoint
CREATE TRIGGER activities_funding_update_valid
BEFORE UPDATE OF funding, merchant_id ON activities
WHEN NEW.funding NOT IN ('merchant','balance')
  OR (NEW.funding='balance' AND NEW.merchant_id IS NOT NULL)
  OR (OLD.opened_at IS NOT NULL AND NEW.funding IS NOT OLD.funding)
BEGIN
  SELECT RAISE(ABORT, 'activity funding invalid');
END;--> statement-breakpoint
PRAGMA defer_foreign_keys=OFF;
