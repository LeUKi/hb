PRAGMA defer_foreign_keys=ON;--> statement-breakpoint
CREATE TABLE `balance_api_keys` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`token_hash` text NOT NULL,
	`last_four` text NOT NULL,
	`daily_limit_minor` integer,
	`created_at` integer NOT NULL,
	`last_transfer_at` integer,
	`last_transfer_ip` text,
	`transfer_count` integer DEFAULT 0 NOT NULL,
	`transfer_total_minor` integer DEFAULT 0 NOT NULL,
	`revoked_at` integer,
	`revoked_by_user_id` text,
	`revoke_reason` text,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`revoked_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "balance_api_keys_valid" CHECK(length("balance_api_keys"."name") BETWEEN 1 AND 20 AND length("balance_api_keys"."last_four") = 4
        AND ("balance_api_keys"."daily_limit_minor" IS NULL OR "balance_api_keys"."daily_limit_minor" >= 1)
        AND "balance_api_keys"."transfer_count" >= 0 AND "balance_api_keys"."transfer_total_minor" >= 0
        AND ("balance_api_keys"."revoked_at" IS NOT NULL OR ("balance_api_keys"."revoked_by_user_id" IS NULL AND "balance_api_keys"."revoke_reason" IS NULL))
        AND ("balance_api_keys"."revoked_by_user_id" IS NULL OR length("balance_api_keys"."revoke_reason") BETWEEN 1 AND 200))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `balance_api_keys_token_unique` ON `balance_api_keys` (`token_hash`);--> statement-breakpoint
CREATE INDEX `balance_api_keys_user_idx` ON `balance_api_keys` (`user_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `balance_transfers` (
	`id` text PRIMARY KEY NOT NULL,
	`from_user_id` text NOT NULL,
	`to_user_id` text NOT NULL,
	`destination` text NOT NULL,
	`withdrawal_id` text,
	`amount_minor` integer NOT NULL,
	`api_key_id` text,
	`out_transfer_no` text,
	`request_id` text,
	`request_digest` text NOT NULL,
	`remark` text,
	`recipient_external_id` text NOT NULL,
	`recipient_username` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`from_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`to_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`withdrawal_id`) REFERENCES `balance_withdrawals`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`api_key_id`) REFERENCES `balance_api_keys`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "balance_transfers_valid" CHECK("balance_transfers"."amount_minor" > 0 AND "balance_transfers"."from_user_id" != "balance_transfers"."to_user_id"
        AND (("balance_transfers"."destination" = 'balance' AND "balance_transfers"."withdrawal_id" IS NULL)
          OR ("balance_transfers"."destination" = 'credit' AND "balance_transfers"."withdrawal_id" IS NOT NULL AND "balance_transfers"."amount_minor" >= 100))
        AND (("balance_transfers"."api_key_id" IS NULL AND "balance_transfers"."out_transfer_no" IS NULL AND "balance_transfers"."request_id" IS NOT NULL)
          OR ("balance_transfers"."api_key_id" IS NOT NULL AND length("balance_transfers"."out_transfer_no") BETWEEN 1 AND 64 AND "balance_transfers"."request_id" IS NULL))
        AND ("balance_transfers"."remark" IS NULL OR length("balance_transfers"."remark") BETWEEN 1 AND 64))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `balance_transfers_out_no_unique` ON `balance_transfers` (`api_key_id`,`out_transfer_no`) WHERE "balance_transfers"."api_key_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `balance_transfers_request_unique` ON `balance_transfers` (`from_user_id`,`request_id`) WHERE "balance_transfers"."request_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `balance_transfers_withdrawal_unique` ON `balance_transfers` (`withdrawal_id`) WHERE "balance_transfers"."withdrawal_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX `balance_transfers_from_time_idx` ON `balance_transfers` (`from_user_id`,`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `balance_transfers_to_time_idx` ON `balance_transfers` (`to_user_id`,`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `balance_transfers_key_time_idx` ON `balance_transfers` (`api_key_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `balance_transfers_time_idx` ON `balance_transfers` (`created_at`,`id`);--> statement-breakpoint
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
	`transfer_id` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`topup_id`) REFERENCES `balance_topups`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`adjustment_id`) REFERENCES `balance_adjustments`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`claim_id`) REFERENCES `claims`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`transfer_id`) REFERENCES `balance_transfers`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "balance_entries_shape_valid" CHECK(("__new_balance_entries"."kind" = 'topup' AND "__new_balance_entries"."topup_id" IS NOT NULL AND "__new_balance_entries"."available_delta_minor" > 0 AND "__new_balance_entries"."locked_delta_minor" = 0 AND "__new_balance_entries"."claim_id" IS NULL)
        OR ("__new_balance_entries"."kind" = 'adjustment' AND "__new_balance_entries"."adjustment_id" IS NOT NULL AND "__new_balance_entries"."available_delta_minor" != 0 AND "__new_balance_entries"."locked_delta_minor" = 0 AND "__new_balance_entries"."claim_id" IS NULL)
        OR ("__new_balance_entries"."kind" = 'lock' AND "__new_balance_entries"."lock_id" IS NOT NULL AND "__new_balance_entries"."available_delta_minor" < 0 AND "__new_balance_entries"."locked_delta_minor" = -"__new_balance_entries"."available_delta_minor" AND "__new_balance_entries"."claim_id" IS NULL)
        OR ("__new_balance_entries"."kind" = 'unlock' AND "__new_balance_entries"."lock_id" IS NOT NULL AND "__new_balance_entries"."available_delta_minor" > 0 AND "__new_balance_entries"."locked_delta_minor" = -"__new_balance_entries"."available_delta_minor" AND "__new_balance_entries"."claim_id" IS NULL)
        OR ("__new_balance_entries"."kind" = 'deduct' AND "__new_balance_entries"."lock_id" IS NOT NULL AND "__new_balance_entries"."available_delta_minor" = 0 AND "__new_balance_entries"."locked_delta_minor" < 0)
        OR ("__new_balance_entries"."kind" = 'hongbao' AND "__new_balance_entries"."lock_id" IS NOT NULL AND "__new_balance_entries"."claim_id" IS NOT NULL AND "__new_balance_entries"."available_delta_minor" > 0 AND "__new_balance_entries"."locked_delta_minor" = 0)
        OR ("__new_balance_entries"."kind" = 'transfer_out' AND "__new_balance_entries"."transfer_id" IS NOT NULL AND "__new_balance_entries"."available_delta_minor" < 0 AND "__new_balance_entries"."locked_delta_minor" = 0 AND "__new_balance_entries"."claim_id" IS NULL)
        OR ("__new_balance_entries"."kind" = 'transfer_in' AND "__new_balance_entries"."transfer_id" IS NOT NULL AND "__new_balance_entries"."available_delta_minor" > 0 AND "__new_balance_entries"."locked_delta_minor" = 0 AND "__new_balance_entries"."claim_id" IS NULL))
);
--> statement-breakpoint
INSERT INTO `__new_balance_entries`("id", "user_id", "kind", "available_delta_minor", "locked_delta_minor", "topup_id", "adjustment_id", "lock_id", "claim_id", "transfer_id", "created_at") SELECT "id", "user_id", "kind", "available_delta_minor", "locked_delta_minor", "topup_id", "adjustment_id", "lock_id", "claim_id", NULL, "created_at" FROM `balance_entries`;--> statement-breakpoint
DROP TABLE `balance_entries`;--> statement-breakpoint
ALTER TABLE `__new_balance_entries` RENAME TO `balance_entries`;--> statement-breakpoint
CREATE UNIQUE INDEX `balance_entries_topup_unique` ON `balance_entries` (`topup_id`) WHERE "balance_entries"."kind" = 'topup';--> statement-breakpoint
CREATE UNIQUE INDEX `balance_entries_adjustment_unique` ON `balance_entries` (`adjustment_id`) WHERE "balance_entries"."kind" = 'adjustment';--> statement-breakpoint
CREATE UNIQUE INDEX `balance_entries_lock_unique` ON `balance_entries` (`lock_id`) WHERE "balance_entries"."kind" = 'lock';--> statement-breakpoint
CREATE UNIQUE INDEX `balance_entries_unlock_unique` ON `balance_entries` (`lock_id`) WHERE "balance_entries"."kind" = 'unlock';--> statement-breakpoint
CREATE UNIQUE INDEX `balance_entries_claim_deduct_unique` ON `balance_entries` (`claim_id`) WHERE "balance_entries"."kind" = 'deduct' AND "balance_entries"."claim_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `balance_entries_claim_hongbao_unique` ON `balance_entries` (`claim_id`) WHERE "balance_entries"."kind" = 'hongbao';--> statement-breakpoint
CREATE UNIQUE INDEX `balance_entries_transfer_out_unique` ON `balance_entries` (`transfer_id`) WHERE "balance_entries"."kind" = 'transfer_out';--> statement-breakpoint
CREATE UNIQUE INDEX `balance_entries_transfer_in_unique` ON `balance_entries` (`transfer_id`) WHERE "balance_entries"."kind" = 'transfer_in';--> statement-breakpoint
CREATE INDEX `balance_entries_user_time_idx` ON `balance_entries` (`user_id`,`created_at`,`id`);--> statement-breakpoint
ALTER TABLE `balance_settings` ADD `transfer_enabled` integer DEFAULT false NOT NULL;--> statement-breakpoint
-- The 🐟额 entries' triggers, as 0033 made them (the rebuild drops them).
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
-- A 转账 to the other's 🐟额 (docs/balance-design.md §16): out of its
-- sender for its whole amount, then into its recipient, once each; no other
-- entry names a 转账.
CREATE TRIGGER balance_entries_transfer_guard
BEFORE INSERT ON balance_entries
WHEN (NEW.kind NOT IN ('transfer_out','transfer_in') AND NEW.transfer_id IS NOT NULL)
  OR (NEW.kind IN ('transfer_out','transfer_in') AND NOT EXISTS (
    SELECT 1 FROM balance_transfers t WHERE t.id=NEW.transfer_id AND t.destination='balance'
      AND ((NEW.kind='transfer_out' AND t.from_user_id=NEW.user_id AND -NEW.available_delta_minor=t.amount_minor)
        OR (NEW.kind='transfer_in' AND t.to_user_id=NEW.user_id AND NEW.available_delta_minor=t.amount_minor
          AND EXISTS (SELECT 1 FROM balance_entries o WHERE o.transfer_id=t.id AND o.kind='transfer_out')))))
BEGIN
  SELECT RAISE(ABORT, 'transfer entry mismatch');
END;--> statement-breakpoint
-- A 转账 is made to an active account as it is, from its sender's own key
-- still in use; one to a Credit account comes with its 转出, made the same
-- moment for the same person and amount. Fixed once made.
CREATE TRIGGER balance_transfers_insert_valid
BEFORE INSERT ON balance_transfers
WHEN NOT EXISTS (SELECT 1 FROM users u WHERE u.id=NEW.to_user_id AND u.provider='linux_do' AND u.active=1
    AND u.external_id=NEW.recipient_external_id AND u.username=NEW.recipient_username)
  OR (NEW.api_key_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM balance_api_keys k
    WHERE k.id=NEW.api_key_id AND k.user_id=NEW.from_user_id AND k.revoked_at IS NULL))
  OR (NEW.destination='credit' AND NOT EXISTS (SELECT 1 FROM balance_withdrawals w
    WHERE w.id=NEW.withdrawal_id AND w.user_id=NEW.from_user_id AND w.status='sending'
      AND w.recipient_id=NEW.recipient_external_id AND w.recipient_username=NEW.recipient_username
      AND w.debit_minor=NEW.amount_minor))
BEGIN
  SELECT RAISE(ABORT, 'transfer is inconsistent');
END;--> statement-breakpoint
CREATE TRIGGER balance_transfers_immutable
BEFORE UPDATE ON balance_transfers
BEGIN
  SELECT RAISE(ABORT, 'transfers are fixed');
END;--> statement-breakpoint
CREATE TRIGGER balance_transfers_permanent
BEFORE DELETE ON balance_transfers
BEGIN
  SELECT RAISE(ABORT, 'transfers are permanent');
END;--> statement-breakpoint
-- An open API key: whose it is never changes, a stop is final, and its
-- totals only grow.
CREATE TRIGGER balance_api_keys_immutable
BEFORE UPDATE ON balance_api_keys
WHEN NEW.id IS NOT OLD.id OR NEW.user_id IS NOT OLD.user_id OR NEW.token_hash IS NOT OLD.token_hash
  OR NEW.last_four IS NOT OLD.last_four OR NEW.created_at IS NOT OLD.created_at
  OR NEW.transfer_count < OLD.transfer_count OR NEW.transfer_total_minor < OLD.transfer_total_minor
  OR (OLD.revoked_at IS NOT NULL AND (NEW.revoked_at IS NOT OLD.revoked_at
    OR NEW.revoked_by_user_id IS NOT OLD.revoked_by_user_id OR NEW.revoke_reason IS NOT OLD.revoke_reason))
BEGIN
  SELECT RAISE(ABORT, 'api key only winds down');
END;--> statement-breakpoint
CREATE TRIGGER balance_api_keys_permanent
BEFORE DELETE ON balance_api_keys
BEGIN
  SELECT RAISE(ABORT, 'api keys are permanent');
END;--> statement-breakpoint
-- A 转出 now also goes to someone else's Credit account (a 转账 to it): its
-- payment pays the 转账's recipient, or the person's own account when there
-- is none. Never the platform app's own author, whom Credit cannot pay.
DROP TRIGGER payment_claim_policy_insert;--> statement-breakpoint
CREATE TRIGGER payment_claim_policy_insert BEFORE INSERT ON payment_tasks
WHEN (NEW.source='claim' AND NEW.mode='real' AND (
 NEW.recovery_policy IS NOT 'claim_same_order_v1' OR NEW.parameter_digest IS NULL
 OR length(NEW.parameter_digest)!=64 OR NEW.parameter_digest GLOB '*[^0-9a-f]*'
 OR NEW.first_send_at IS NOT NULL
 OR NOT EXISTS(SELECT 1 FROM claims c JOIN users u ON u.id=c.user_id
    JOIN activities a ON a.id=c.activity_id
    JOIN reward_inventory r ON r.id=c.inventory_id AND r.activity_id=a.id
    WHERE c.id=NEW.claim_id AND u.external_id=NEW.recipient_id
      AND u.username=NEW.recipient_username AND a.opened_at IS NOT NULL
      AND a.author_id!=c.user_id AND a.merchant_id=NEW.merchant_id
      AND a.payment_mode='real' AND r.kind='ldc' AND r.amount_minor=NEW.amount_minor)
)) OR (NEW.source='withdrawal' AND (
 NEW.recovery_policy IS NOT 'withdrawal_same_order_v1' OR NEW.parameter_digest IS NULL
 OR length(NEW.parameter_digest)!=64 OR NEW.parameter_digest GLOB '*[^0-9a-f]*'
 OR NEW.first_send_at IS NOT NULL
 OR NOT EXISTS(SELECT 1 FROM balance_withdrawals w
    JOIN users u ON u.id=COALESCE((SELECT t.to_user_id FROM balance_transfers t WHERE t.withdrawal_id=w.id), w.user_id)
    JOIN merchants m ON m.id=w.merchant_id
    JOIN balance_locks l ON l.withdrawal_id=w.id AND l.status='active' AND l.remaining_minor=w.debit_minor
    WHERE w.id=NEW.withdrawal_id AND u.provider='linux_do' AND u.external_id=NEW.recipient_id
      AND m.kind='platform' AND m.author_id!=u.id)
)) OR ((NEW.mode!='real' OR NEW.source NOT IN ('claim','withdrawal')) AND (NEW.recovery_policy IS NOT NULL OR NEW.parameter_digest IS NOT NULL OR NEW.first_send_at IS NOT NULL))
BEGIN SELECT RAISE(ABORT, 'ordinary payment authorization mismatch'); END;--> statement-breakpoint
PRAGMA defer_foreign_keys=OFF;
