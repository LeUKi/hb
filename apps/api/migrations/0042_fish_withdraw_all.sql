-- 转出 under 1 🐟 when it is all of 可用 (docs/balance-design.md §5, 2026-10-25):
-- balance_withdrawals_amounts_valid asks debit_minor > 0, not >= 100; the
-- server keeps a part at 1 🐟 or more. SQLite rebuilds the table for it.
PRAGMA defer_foreign_keys=ON;--> statement-breakpoint
-- Triggers elsewhere that read balance_withdrawals go while it is rebuilt.
DROP TRIGGER payment_tasks_insert_consistency;--> statement-breakpoint
DROP TRIGGER balance_transfers_insert_valid;--> statement-breakpoint
DROP TRIGGER payment_claim_policy_insert;--> statement-breakpoint
CREATE TABLE `__new_balance_withdrawals` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`merchant_id` text NOT NULL,
	`client_id` text NOT NULL,
	`business_no` text NOT NULL,
	`recipient_id` text NOT NULL,
	`recipient_username` text NOT NULL,
	`debit_minor` integer NOT NULL,
	`fee_minor` integer NOT NULL,
	`credit_minor` integer NOT NULL,
	`fee_percent` integer NOT NULL,
	`settings_version` integer NOT NULL,
	`status` text DEFAULT 'sending' NOT NULL,
	`failure_reason` text,
	`request_id` text NOT NULL,
	`request_digest` text NOT NULL,
	`created_at` integer NOT NULL,
	`sent_at` integer,
	`failed_at` integer,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`merchant_id`) REFERENCES `merchants`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "balance_withdrawals_amounts_valid" CHECK("__new_balance_withdrawals"."debit_minor" > 0 AND "__new_balance_withdrawals"."fee_minor" >= 0 AND "__new_balance_withdrawals"."credit_minor" > 0 AND "__new_balance_withdrawals"."debit_minor" = "__new_balance_withdrawals"."credit_minor" + "__new_balance_withdrawals"."fee_minor" AND "__new_balance_withdrawals"."fee_percent" BETWEEN 0 AND 50),
	CONSTRAINT "balance_withdrawals_status_valid" CHECK(("__new_balance_withdrawals"."status" = 'sending' AND "__new_balance_withdrawals"."sent_at" IS NULL AND "__new_balance_withdrawals"."failed_at" IS NULL AND "__new_balance_withdrawals"."failure_reason" IS NULL)
        OR ("__new_balance_withdrawals"."status" = 'sent' AND "__new_balance_withdrawals"."sent_at" IS NOT NULL AND "__new_balance_withdrawals"."failed_at" IS NULL AND "__new_balance_withdrawals"."failure_reason" IS NULL)
        OR ("__new_balance_withdrawals"."status" = 'failed' AND "__new_balance_withdrawals"."sent_at" IS NULL AND "__new_balance_withdrawals"."failed_at" IS NOT NULL AND "__new_balance_withdrawals"."failure_reason" IN ('recipient','self_payment','configuration','validation')))
);
--> statement-breakpoint
INSERT INTO `__new_balance_withdrawals`("id", "user_id", "merchant_id", "client_id", "business_no", "recipient_id", "recipient_username", "debit_minor", "fee_minor", "credit_minor", "fee_percent", "settings_version", "status", "failure_reason", "request_id", "request_digest", "created_at", "sent_at", "failed_at", "updated_at") SELECT "id", "user_id", "merchant_id", "client_id", "business_no", "recipient_id", "recipient_username", "debit_minor", "fee_minor", "credit_minor", "fee_percent", "settings_version", "status", "failure_reason", "request_id", "request_digest", "created_at", "sent_at", "failed_at", "updated_at" FROM `balance_withdrawals`;--> statement-breakpoint
DROP TABLE `balance_withdrawals`;--> statement-breakpoint
ALTER TABLE `__new_balance_withdrawals` RENAME TO `balance_withdrawals`;--> statement-breakpoint
CREATE UNIQUE INDEX `balance_withdrawals_business_no_unique` ON `balance_withdrawals` (`business_no`);--> statement-breakpoint
CREATE UNIQUE INDEX `balance_withdrawals_request_unique` ON `balance_withdrawals` (`user_id`,`request_id`);--> statement-breakpoint
CREATE INDEX `balance_withdrawals_user_time_idx` ON `balance_withdrawals` (`user_id`,`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `balance_withdrawals_status_time_idx` ON `balance_withdrawals` (`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `balance_withdrawals_time_idx` ON `balance_withdrawals` (`created_at`,`id`);--> statement-breakpoint
-- Its own triggers went with it: back as they were.
CREATE TRIGGER balance_withdrawals_insert_valid
BEFORE INSERT ON balance_withdrawals
WHEN NEW.status!='sending' OR NOT EXISTS (
  SELECT 1 FROM merchants m WHERE m.id=NEW.merchant_id AND m.kind='platform' AND m.client_id=NEW.client_id)
BEGIN
  SELECT RAISE(ABORT, 'withdrawal must start sending from the platform app');
END;--> statement-breakpoint
CREATE TRIGGER balance_withdrawals_identity_immutable
BEFORE UPDATE ON balance_withdrawals
WHEN NEW.id IS NOT OLD.id OR NEW.user_id IS NOT OLD.user_id OR NEW.merchant_id IS NOT OLD.merchant_id
  OR NEW.client_id IS NOT OLD.client_id OR NEW.business_no IS NOT OLD.business_no
  OR NEW.recipient_id IS NOT OLD.recipient_id OR NEW.recipient_username IS NOT OLD.recipient_username
  OR NEW.debit_minor IS NOT OLD.debit_minor OR NEW.fee_minor IS NOT OLD.fee_minor
  OR NEW.credit_minor IS NOT OLD.credit_minor OR NEW.fee_percent IS NOT OLD.fee_percent
  OR NEW.settings_version IS NOT OLD.settings_version OR NEW.request_id IS NOT OLD.request_id
  OR NEW.request_digest IS NOT OLD.request_digest OR NEW.created_at IS NOT OLD.created_at
BEGIN
  SELECT RAISE(ABORT, 'withdrawal identity immutable');
END;--> statement-breakpoint
CREATE TRIGGER balance_withdrawals_status_final
BEFORE UPDATE OF status ON balance_withdrawals
WHEN NEW.status IS NOT OLD.status AND (OLD.status!='sending'
  OR (NEW.status='sent' AND NOT EXISTS (SELECT 1 FROM payment_tasks p WHERE p.withdrawal_id=NEW.id AND p.status='confirmed'))
  OR (NEW.status='failed' AND NOT EXISTS (SELECT 1 FROM payment_tasks p WHERE p.withdrawal_id=NEW.id AND p.status='failed')))
BEGIN
  SELECT RAISE(ABORT, 'withdrawal ends only as its payment does');
END;--> statement-breakpoint
CREATE TRIGGER balance_withdrawals_permanent
BEFORE DELETE ON balance_withdrawals
BEGIN
  SELECT RAISE(ABORT, 'withdrawals are permanent');
END;--> statement-breakpoint
-- The others back; payment_tasks_insert_consistency now finds a claim's
-- share by reward_inventory's whole key (activity_id, id), not by id alone,
-- which read every 红包's inventory (06 §12).
CREATE TRIGGER payment_tasks_insert_consistency BEFORE INSERT ON payment_tasks
WHEN NOT EXISTS (SELECT 1 FROM merchants WHERE id=NEW.merchant_id AND client_id=NEW.client_id AND mode=NEW.mode)
OR (NEW.source='withdrawal' AND NEW.status!='pending')
OR (NEW.source='claim' AND NOT EXISTS (
 SELECT 1 FROM claims c JOIN activities a ON a.id=c.activity_id JOIN reward_inventory r ON r.activity_id=c.activity_id AND r.id=c.inventory_id
 WHERE c.id=NEW.claim_id AND a.reward_type='ldc' AND a.merchant_id=NEW.merchant_id AND a.payment_mode=NEW.mode AND r.amount_minor=NEW.amount_minor
))
OR (NEW.source='acceptance' AND NOT EXISTS (
 SELECT 1 FROM payment_acceptances a WHERE a.id=NEW.acceptance_id AND a.merchant_id=NEW.merchant_id
 AND a.client_id=NEW.client_id AND a.business_no=NEW.business_no AND a.recipient_id=NEW.recipient_id
 AND a.recipient_username=NEW.recipient_username AND a.amount_minor=NEW.amount_minor
))
OR (NEW.source='withdrawal' AND NOT EXISTS (
 SELECT 1 FROM balance_withdrawals w JOIN merchants m ON m.id=w.merchant_id
 WHERE w.id=NEW.withdrawal_id AND w.status='sending' AND m.kind='platform'
 AND w.merchant_id=NEW.merchant_id AND w.client_id=NEW.client_id AND w.business_no=NEW.business_no
 AND w.recipient_id=NEW.recipient_id AND w.recipient_username=NEW.recipient_username AND w.debit_minor=NEW.amount_minor
))
BEGIN SELECT RAISE(ABORT, 'payment task is inconsistent'); END;--> statement-breakpoint
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
-- The same for a 🐟额红包's deduction.
DROP TRIGGER balance_entries_lock_guard;--> statement-breakpoint
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
          OR (l.purpose='activity' AND EXISTS (SELECT 1 FROM claims c JOIN reward_inventory r ON r.activity_id=c.activity_id AND r.id=c.inventory_id
            WHERE c.id=NEW.claim_id AND c.activity_id=l.activity_id AND r.amount_minor=-NEW.locked_delta_minor))))))
BEGIN
  SELECT RAISE(ABORT, 'balance lock entry mismatch');
END;--> statement-breakpoint
PRAGMA defer_foreign_keys=OFF;
