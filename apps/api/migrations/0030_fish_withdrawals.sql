CREATE TABLE `balance_locks` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`purpose` text NOT NULL,
	`withdrawal_id` text,
	`activity_id` text,
	`amount_minor` integer NOT NULL,
	`remaining_minor` integer NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`withdrawal_id`) REFERENCES `balance_withdrawals`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "balance_locks_purpose_valid" CHECK(("balance_locks"."purpose" = 'withdrawal' AND "balance_locks"."withdrawal_id" IS NOT NULL AND "balance_locks"."activity_id" IS NULL)
        OR ("balance_locks"."purpose" = 'activity' AND "balance_locks"."activity_id" IS NOT NULL AND "balance_locks"."withdrawal_id" IS NULL)),
	CONSTRAINT "balance_locks_amounts_valid" CHECK("balance_locks"."amount_minor" > 0 AND "balance_locks"."remaining_minor" BETWEEN 0 AND "balance_locks"."amount_minor"
        AND ("balance_locks"."status" = 'active' OR "balance_locks"."remaining_minor" = 0)
        AND "balance_locks"."status" IN ('active','released','spent'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `balance_locks_withdrawal_unique` ON `balance_locks` (`withdrawal_id`);--> statement-breakpoint
CREATE INDEX `balance_locks_user_status_idx` ON `balance_locks` (`user_id`,`status`);--> statement-breakpoint
CREATE TABLE `balance_withdrawals` (
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
	CONSTRAINT "balance_withdrawals_amounts_valid" CHECK("balance_withdrawals"."debit_minor" >= 100 AND "balance_withdrawals"."fee_minor" >= 0 AND "balance_withdrawals"."credit_minor" > 0 AND "balance_withdrawals"."debit_minor" = "balance_withdrawals"."credit_minor" + "balance_withdrawals"."fee_minor" AND "balance_withdrawals"."fee_percent" BETWEEN 0 AND 50),
	CONSTRAINT "balance_withdrawals_status_valid" CHECK(("balance_withdrawals"."status" = 'sending' AND "balance_withdrawals"."sent_at" IS NULL AND "balance_withdrawals"."failed_at" IS NULL AND "balance_withdrawals"."failure_reason" IS NULL)
        OR ("balance_withdrawals"."status" = 'sent' AND "balance_withdrawals"."sent_at" IS NOT NULL AND "balance_withdrawals"."failed_at" IS NULL AND "balance_withdrawals"."failure_reason" IS NULL)
        OR ("balance_withdrawals"."status" = 'failed' AND "balance_withdrawals"."sent_at" IS NULL AND "balance_withdrawals"."failed_at" IS NOT NULL AND "balance_withdrawals"."failure_reason" IN ('recipient','self_payment','configuration','validation')))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `balance_withdrawals_business_no_unique` ON `balance_withdrawals` (`business_no`);--> statement-breakpoint
CREATE UNIQUE INDEX `balance_withdrawals_request_unique` ON `balance_withdrawals` (`user_id`,`request_id`);--> statement-breakpoint
CREATE INDEX `balance_withdrawals_user_time_idx` ON `balance_withdrawals` (`user_id`,`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `balance_withdrawals_status_time_idx` ON `balance_withdrawals` (`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `balance_withdrawals_time_idx` ON `balance_withdrawals` (`created_at`,`id`);--> statement-breakpoint
PRAGMA defer_foreign_keys=ON;--> statement-breakpoint
-- Triggers elsewhere that read payment_tasks go while it is rebuilt.
DROP TRIGGER payment_duplicate_probes_insert_guard;--> statement-breakpoint
DROP TRIGGER payment_identity_corrections_insert_guard;--> statement-breakpoint
DROP TRIGGER payment_identity_corrections_invalidate;--> statement-breakpoint
DROP TRIGGER payment_retry_grants_insert_guard;--> statement-breakpoint
DROP TRIGGER payment_username_corrections_insert_guard;--> statement-breakpoint
DROP TRIGGER payment_username_corrections_resume;--> statement-breakpoint
CREATE TABLE `__new_payment_tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`claim_id` text,
	`source` text DEFAULT 'claim' NOT NULL,
	`acceptance_id` text,
	`withdrawal_id` text,
	`merchant_id` text NOT NULL,
	`client_id` text NOT NULL,
	`business_no` text NOT NULL,
	`recipient_id` text NOT NULL,
	`recipient_username` text,
	`amount_minor` integer NOT NULL,
	`mode` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`reason` text,
	`external_order_id` text,
	`attempt_count` integer DEFAULT 0 NOT NULL,
	`reconciliation_count` integer DEFAULT 0 NOT NULL,
	`unknown_outcome` integer DEFAULT false NOT NULL,
	`next_run_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`confirmed_at` integer,
	`send_acknowledged_at` integer,
	`recovery_policy` text,
	`parameter_digest` text,
	`first_send_at` integer,
	`next_action` text DEFAULT 'query' NOT NULL,
	`next_send_at` integer,
	`next_query_at` integer,
	`send_backoff_count` integer DEFAULT 0 NOT NULL,
	`query_backoff_count` integer DEFAULT 0 NOT NULL,
	`send_block_reason` text,
	`order_observed_at` integer,
	`order_evidence` text,
	`queried_send_count` integer,
	`recovery_version` integer DEFAULT 0 NOT NULL,
	`queried_recovery_version` integer,
	`query_retry_after_at` integer,
	FOREIGN KEY (`claim_id`) REFERENCES `claims`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`acceptance_id`) REFERENCES `payment_acceptances`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`withdrawal_id`) REFERENCES `balance_withdrawals`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`merchant_id`) REFERENCES `merchants`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "payment_tasks_source_valid" CHECK(("__new_payment_tasks"."source" = 'claim' AND "__new_payment_tasks"."claim_id" IS NOT NULL AND "__new_payment_tasks"."acceptance_id" IS NULL AND "__new_payment_tasks"."withdrawal_id" IS NULL) OR ("__new_payment_tasks"."source" = 'acceptance' AND "__new_payment_tasks"."claim_id" IS NULL AND "__new_payment_tasks"."acceptance_id" IS NOT NULL AND "__new_payment_tasks"."withdrawal_id" IS NULL AND "__new_payment_tasks"."mode" = 'real') OR ("__new_payment_tasks"."source" = 'withdrawal' AND "__new_payment_tasks"."claim_id" IS NULL AND "__new_payment_tasks"."acceptance_id" IS NULL AND "__new_payment_tasks"."withdrawal_id" IS NOT NULL AND "__new_payment_tasks"."mode" = 'real')),
	CONSTRAINT "payment_tasks_mode_valid" CHECK("__new_payment_tasks"."mode" IN ('simulation','real')),
	CONSTRAINT "payment_tasks_recipient_snapshot" CHECK(("__new_payment_tasks"."mode" = 'simulation' AND "__new_payment_tasks"."recipient_id" LIKE 'simulation:%') OR ("__new_payment_tasks"."mode" = 'real' AND "__new_payment_tasks"."recipient_username" IS NOT NULL AND length("__new_payment_tasks"."recipient_username") > 0 AND "__new_payment_tasks"."recipient_id" GLOB '[1-9]*' AND "__new_payment_tasks"."recipient_id" NOT GLOB '*[^0-9]*' AND length("__new_payment_tasks"."recipient_id") <= 20)),
	CONSTRAINT "payment_tasks_amount_positive" CHECK(typeof("__new_payment_tasks"."amount_minor") = 'integer' AND "__new_payment_tasks"."amount_minor" > 0 AND "__new_payment_tasks"."amount_minor" <= 9007199254740991)
);
--> statement-breakpoint
INSERT INTO `__new_payment_tasks`("id", "claim_id", "source", "acceptance_id", "withdrawal_id", "merchant_id", "client_id", "business_no", "recipient_id", "recipient_username", "amount_minor", "mode", "status", "reason", "external_order_id", "attempt_count", "reconciliation_count", "unknown_outcome", "next_run_at", "created_at", "updated_at", "confirmed_at", "send_acknowledged_at", "recovery_policy", "parameter_digest", "first_send_at", "next_action", "next_send_at", "next_query_at", "send_backoff_count", "query_backoff_count", "send_block_reason", "order_observed_at", "order_evidence", "queried_send_count", "recovery_version", "queried_recovery_version", "query_retry_after_at") SELECT "id", "claim_id", "source", "acceptance_id", NULL, "merchant_id", "client_id", "business_no", "recipient_id", "recipient_username", "amount_minor", "mode", "status", "reason", "external_order_id", "attempt_count", "reconciliation_count", "unknown_outcome", "next_run_at", "created_at", "updated_at", "confirmed_at", "send_acknowledged_at", "recovery_policy", "parameter_digest", "first_send_at", "next_action", "next_send_at", "next_query_at", "send_backoff_count", "query_backoff_count", "send_block_reason", "order_observed_at", "order_evidence", "queried_send_count", "recovery_version", "queried_recovery_version", "query_retry_after_at" FROM `payment_tasks`;--> statement-breakpoint
DROP TABLE `payment_tasks`;--> statement-breakpoint
ALTER TABLE `__new_payment_tasks` RENAME TO `payment_tasks`;--> statement-breakpoint
CREATE UNIQUE INDEX `payment_tasks_claim_unique` ON `payment_tasks` (`claim_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `payment_tasks_acceptance_unique` ON `payment_tasks` (`acceptance_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `payment_tasks_withdrawal_unique` ON `payment_tasks` (`withdrawal_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `payment_tasks_business_unique` ON `payment_tasks` (`client_id`,`business_no`);--> statement-breakpoint
CREATE INDEX `payment_tasks_due_idx` ON `payment_tasks` (`status`,`next_run_at`);--> statement-breakpoint
CREATE INDEX `payment_tasks_merchant_active_order_idx` ON `payment_tasks` (`merchant_id`,`created_at`,`id`) WHERE "payment_tasks"."status" IN ('pending','waiting','reconciling','sending');--> statement-breakpoint
CREATE INDEX `payment_tasks_merchant_time_idx` ON `payment_tasks` (`merchant_id`,`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `payment_tasks_admin_time_idx` ON `payment_tasks` (`created_at` DESC, `id` DESC);--> statement-breakpoint
CREATE INDEX `payment_tasks_admin_status_time_idx` ON `payment_tasks` (`status`, `created_at` DESC, `id` DESC);--> statement-breakpoint
CREATE INDEX `payment_tasks_admin_mode_status_time_idx` ON `payment_tasks` (`mode`, `status`, `created_at` DESC, `id` DESC);--> statement-breakpoint
CREATE UNIQUE INDEX `balance_entries_lock_unique` ON `balance_entries` (`lock_id`) WHERE "balance_entries"."kind" = 'lock';--> statement-breakpoint
CREATE UNIQUE INDEX `balance_entries_unlock_unique` ON `balance_entries` (`lock_id`) WHERE "balance_entries"."kind" = 'unlock';--> statement-breakpoint
-- Back as they were.
CREATE TRIGGER payment_duplicate_probes_insert_guard BEFORE INSERT ON payment_duplicate_probes
WHEN NOT EXISTS (SELECT 1 FROM payment_tasks p JOIN payment_retry_grants g ON g.task_id=p.id
 LEFT JOIN payment_username_corrections c ON c.task_id=p.id
 WHERE p.id=NEW.task_id AND p.mode='real' AND p.source='acceptance' AND p.status='confirmed'
 AND p.external_order_id=NEW.baseline_external_order_id AND COALESCE(c.corrected_parameter_digest,g.parameter_digest)=NEW.parameter_digest)
 OR NEW.status!='pending' OR NEW.permit_consumed_at IS NOT NULL OR NEW.protocol_verified_at IS NOT NULL
 OR NEW.backend_verified_at IS NOT NULL OR NEW.query_count!=0
BEGIN SELECT RAISE(ABORT, 'duplicate probe requires a confirmed matching acceptance'); END;--> statement-breakpoint
CREATE TRIGGER payment_identity_corrections_insert_guard BEFORE INSERT ON payment_identity_corrections
WHEN NEW.version!=COALESCE((SELECT MAX(version)+1 FROM payment_identity_corrections WHERE task_id=NEW.task_id),1)
 OR NOT EXISTS(
 SELECT 1 FROM payment_tasks p JOIN merchants m ON m.id=p.merchant_id
 JOIN merchant_credentials c ON c.merchant_id=m.id AND c.version=m.credential_version
 WHERE p.id=NEW.task_id AND p.source='claim' AND p.mode='real' AND p.recovery_policy='claim_same_order_v1'
 AND p.status!='confirmed' AND p.confirmed_at IS NULL AND p.unknown_outcome=0
 AND p.external_order_id IS NULL AND p.order_observed_at IS NULL AND p.send_acknowledged_at IS NULL
 AND COALESCE(p.send_block_reason,'')!='conflict' AND m.lease_token IS NULL
 AND NOT EXISTS(SELECT 1 FROM payment_attempts a WHERE a.task_id=p.id AND (a.outcome='started' OR a.finished_at IS NULL))
 AND m.version=NEW.merchant_version AND m.client_id=NEW.corrected_client_id
 AND c.version=NEW.credential_version AND c.client_id=m.client_id AND c.verification_status='passed'
 AND NEW.original_client_id=COALESCE((SELECT corrected_client_id FROM payment_identity_corrections WHERE task_id=p.id ORDER BY version DESC LIMIT 1),p.client_id)
 AND NEW.original_parameter_digest=COALESCE((SELECT corrected_parameter_digest FROM payment_identity_corrections WHERE task_id=p.id ORDER BY version DESC LIMIT 1),p.parameter_digest)
 AND NEW.corrected_client_id!=NEW.original_client_id
 AND length(NEW.corrected_parameter_digest)=64 AND NEW.corrected_parameter_digest NOT GLOB '*[^0-9a-f]*'
 AND ((NEW.evidence='never_sent' AND p.attempt_count=0 AND p.first_send_at IS NULL
       AND NOT EXISTS(SELECT 1 FROM payment_attempts a WHERE a.task_id=p.id AND a.operation='send'))
   OR (NEW.evidence='rejected_no_order' AND p.attempt_count>0
       AND p.attempt_count=(SELECT COUNT(*) FROM payment_attempts a WHERE a.task_id=p.id AND a.operation='send' AND a.purpose='recovery')
       AND NOT EXISTS(SELECT 1 FROM payment_attempts a WHERE a.task_id=p.id AND a.operation='send' AND (a.no_order_evidence IS NOT 'protocol_rejection_v1' OR a.outcome!='rejected' OR a.finished_at IS NULL))))
 )
BEGIN SELECT RAISE(ABORT,'unsafe payment identity correction'); END;--> statement-breakpoint
CREATE TRIGGER payment_identity_corrections_invalidate AFTER INSERT ON payment_identity_corrections
BEGIN UPDATE payment_tasks SET recovery_version=recovery_version+1,queried_send_count=NULL,queried_recovery_version=NULL,updated_at=NEW.created_at WHERE id=NEW.task_id; END;--> statement-breakpoint
CREATE TRIGGER payment_retry_grants_insert_guard BEFORE INSERT ON payment_retry_grants
WHEN NOT EXISTS (SELECT 1 FROM payment_tasks p JOIN payment_acceptances a ON a.id=p.acceptance_id
 WHERE p.id=NEW.task_id AND p.source='acceptance' AND p.mode='real' AND a.send_consumed_at IS NOT NULL)
 OR NEW.used_additional_sends!=0 OR NEW.revoked_at IS NOT NULL
 OR length(NEW.parameter_digest)!=64 OR NEW.parameter_digest GLOB '*[^0-9a-f]*'
BEGIN SELECT RAISE(ABORT, 'retry grant requires an existing real acceptance'); END;--> statement-breakpoint
CREATE TRIGGER payment_username_corrections_insert_guard BEFORE INSERT ON payment_username_corrections
WHEN EXISTS(SELECT 1 FROM payment_username_corrections c WHERE c.task_id=NEW.task_id)
 OR NOT EXISTS(SELECT 1 FROM payment_tasks p JOIN payment_retry_grants g ON g.task_id=p.id JOIN merchants m ON m.id=p.merchant_id
  WHERE p.id=NEW.task_id AND p.mode='real' AND p.source='acceptance' AND p.status!='confirmed'
   AND p.recipient_username=NEW.original_username AND p.send_block_reason='recipient'
   AND p.order_observed_at IS NULL AND p.order_evidence IS NULL AND p.external_order_id IS NULL AND p.send_acknowledged_at IS NULL
   AND m.lease_token IS NULL AND g.parameter_digest=NEW.original_parameter_digest
   AND g.revoked_at IS NULL AND g.expires_at>NEW.created_at AND g.used_additional_sends<g.max_additional_sends)
 OR EXISTS(SELECT 1 FROM payment_duplicate_probes d WHERE d.task_id=NEW.task_id)
BEGIN SELECT RAISE(ABORT, 'username correction requires an unused recovery opportunity and no observed order'); END;--> statement-breakpoint
CREATE TRIGGER payment_username_corrections_resume AFTER INSERT ON payment_username_corrections
BEGIN
 UPDATE payment_tasks SET status='reconciling',send_block_reason=NULL,next_action='query',
  next_query_at=MAX(NEW.created_at,COALESCE(query_retry_after_at,0)),next_run_at=MAX(NEW.created_at,COALESCE(query_retry_after_at,0)),
  next_send_at=MAX(COALESCE(next_send_at,0),NEW.created_at+10000,COALESCE(query_retry_after_at,0)),
  queried_send_count=NULL,queried_recovery_version=NULL,recovery_version=recovery_version+1,updated_at=NEW.created_at
 WHERE id=NEW.task_id;
END;--> statement-breakpoint
-- payment_tasks was rebuilt (a 转出 source): its six triggers come back,
-- each also covering 转出, the same-order policy of its own and 未发出.
CREATE TRIGGER payment_tasks_insert_consistency BEFORE INSERT ON payment_tasks
WHEN NOT EXISTS (SELECT 1 FROM merchants WHERE id=NEW.merchant_id AND client_id=NEW.client_id AND mode=NEW.mode)
OR (NEW.source='withdrawal' AND NEW.status!='pending')
OR (NEW.source='claim' AND NOT EXISTS (
 SELECT 1 FROM claims c JOIN activities a ON a.id=c.activity_id JOIN reward_inventory r ON r.id=c.inventory_id
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
CREATE TRIGGER payment_tasks_immutable_identity BEFORE UPDATE ON payment_tasks
WHEN OLD.id IS NOT NEW.id OR OLD.claim_id IS NOT NEW.claim_id OR OLD.source IS NOT NEW.source OR OLD.acceptance_id IS NOT NEW.acceptance_id
 OR OLD.withdrawal_id IS NOT NEW.withdrawal_id
 OR OLD.mode IS NOT NEW.mode OR OLD.merchant_id IS NOT NEW.merchant_id OR OLD.client_id IS NOT NEW.client_id
 OR OLD.business_no IS NOT NEW.business_no OR OLD.recipient_id IS NOT NEW.recipient_id
 OR OLD.recipient_username IS NOT NEW.recipient_username OR OLD.amount_minor IS NOT NEW.amount_minor
BEGIN SELECT RAISE(ABORT, 'payment task identity is immutable'); END;--> statement-breakpoint
-- 未发出 is final, and only for a 转出 Credit refused with no order made.
CREATE TRIGGER payment_tasks_real_evidence_sticky BEFORE UPDATE ON payment_tasks
WHEN OLD.mode='real' AND (
 (OLD.order_observed_at IS NOT NULL AND NEW.order_observed_at IS NULL)
 OR (OLD.order_evidence IS NOT NULL AND NEW.order_evidence IS NULL)
 OR (OLD.external_order_id IS NOT NULL AND OLD.external_order_id IS NOT NEW.external_order_id)
 OR (OLD.unknown_outcome=1 AND NEW.unknown_outcome=0 AND NEW.status!='confirmed')
 OR (OLD.status='confirmed' AND NEW.status!='confirmed')
 OR (OLD.status='failed' AND NEW.status!='failed')
 OR (OLD.confirmed_at IS NOT NULL AND OLD.confirmed_at IS NOT NEW.confirmed_at)
 OR (NEW.status='failed' AND OLD.status!='failed' AND (NEW.source!='withdrawal' OR NEW.unknown_outcome!=0
   OR NEW.order_observed_at IS NOT NULL OR NEW.external_order_id IS NOT NULL OR NEW.send_acknowledged_at IS NOT NULL
   OR COALESCE(NEW.send_block_reason,'') NOT IN ('recipient','self_payment','configuration','validation'))))
BEGIN SELECT RAISE(ABORT, 'observed real payment evidence cannot be cleared'); END;--> statement-breakpoint
CREATE TRIGGER payment_tasks_no_replace BEFORE INSERT ON payment_tasks
WHEN EXISTS(SELECT 1 FROM payment_tasks WHERE id=NEW.id OR (client_id=NEW.client_id AND business_no=NEW.business_no)
 OR claim_id=NEW.claim_id OR acceptance_id=NEW.acceptance_id OR withdrawal_id=NEW.withdrawal_id)
BEGIN SELECT RAISE(ABORT, 'payment task cannot be replaced'); END;--> statement-breakpoint
CREATE TRIGGER payment_claim_policy_immutable BEFORE UPDATE ON payment_tasks
WHEN NEW.recovery_policy IS NOT OLD.recovery_policy OR NEW.parameter_digest IS NOT OLD.parameter_digest
 OR (OLD.first_send_at IS NOT NULL AND NEW.first_send_at IS NOT OLD.first_send_at)
 OR (NEW.first_send_at IS NOT NULL AND (NEW.mode!='real' OR NOT (
   (NEW.source='claim' AND NEW.recovery_policy IS 'claim_same_order_v1')
   OR (NEW.source='withdrawal' AND NEW.recovery_policy IS 'withdrawal_same_order_v1'))))
BEGIN SELECT RAISE(ABORT, 'ordinary payment authorization is immutable'); END;--> statement-breakpoint
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
 OR NOT EXISTS(SELECT 1 FROM balance_withdrawals w JOIN users u ON u.id=w.user_id
    JOIN merchants m ON m.id=w.merchant_id
    JOIN balance_locks l ON l.withdrawal_id=w.id AND l.status='active' AND l.remaining_minor=w.debit_minor
    WHERE w.id=NEW.withdrawal_id AND u.provider='linux_do' AND u.external_id=NEW.recipient_id
      AND m.kind='platform' AND m.author_id!=w.user_id)
)) OR ((NEW.mode!='real' OR NEW.source NOT IN ('claim','withdrawal')) AND (NEW.recovery_policy IS NOT NULL OR NEW.parameter_digest IS NOT NULL OR NEW.first_send_at IS NOT NULL))
BEGIN SELECT RAISE(ABORT, 'ordinary payment authorization mismatch'); END;--> statement-breakpoint
-- 🐟额 locks: made whole, given back whole or taken, never anything else.
CREATE TRIGGER balance_locks_insert_valid
BEFORE INSERT ON balance_locks
WHEN NEW.status!='active' OR NEW.remaining_minor!=NEW.amount_minor
BEGIN
  SELECT RAISE(ABORT, 'balance lock starts active and whole');
END;--> statement-breakpoint
CREATE TRIGGER balance_locks_immutable
BEFORE UPDATE ON balance_locks
WHEN NEW.id IS NOT OLD.id OR NEW.user_id IS NOT OLD.user_id OR NEW.purpose IS NOT OLD.purpose
  OR NEW.withdrawal_id IS NOT OLD.withdrawal_id OR NEW.activity_id IS NOT OLD.activity_id
  OR NEW.amount_minor IS NOT OLD.amount_minor OR NEW.created_at IS NOT OLD.created_at
  OR NEW.remaining_minor > OLD.remaining_minor
  OR (OLD.status!='active' AND (NEW.status IS NOT OLD.status OR NEW.remaining_minor IS NOT OLD.remaining_minor))
BEGIN
  SELECT RAISE(ABORT, 'balance lock only winds down');
END;--> statement-breakpoint
CREATE TRIGGER balance_locks_permanent
BEFORE DELETE ON balance_locks
BEGIN
  SELECT RAISE(ABORT, 'balance locks are permanent');
END;--> statement-breakpoint
-- A lock's entries: made for its whole amount, given back whole, or taken
-- in parts no larger than what it still holds; each moves the lock too.
CREATE TRIGGER balance_entries_lock_guard
BEFORE INSERT ON balance_entries
WHEN NEW.kind IN ('lock','unlock','deduct') AND NOT EXISTS (
  SELECT 1 FROM balance_locks l WHERE l.id=NEW.lock_id AND l.user_id=NEW.user_id AND l.status='active'
    AND ((NEW.kind='lock' AND l.remaining_minor=l.amount_minor AND NEW.locked_delta_minor=l.amount_minor)
      OR (NEW.kind='unlock' AND -NEW.locked_delta_minor=l.remaining_minor)
      OR (NEW.kind='deduct' AND -NEW.locked_delta_minor<=l.remaining_minor)))
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
-- A 转出 is fixed when asked for, and ends only as its payment does:
-- 已发放 once the payment is confirmed, 未发出 once it is refused for good.
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
PRAGMA defer_foreign_keys=OFF;
