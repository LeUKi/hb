CREATE TABLE `payment_duplicate_probes` (
	`task_id` text PRIMARY KEY NOT NULL,
	`baseline_external_order_id` text NOT NULL,
	`parameter_digest` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`permit_consumed_at` integer,
	`next_run_at` integer NOT NULL,
	`query_count` integer DEFAULT 0 NOT NULL,
	`reason` text,
	`http_status` integer,
	`protocol_verified_at` integer,
	`backend_verified_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`task_id`) REFERENCES `payment_tasks`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "payment_duplicate_probes_status_valid" CHECK("payment_duplicate_probes"."status" IN ('pending','sending','reconciling','awaiting_evidence','passed','inconclusive','conflict')),
	CONSTRAINT "payment_duplicate_probes_pass_evidence" CHECK("payment_duplicate_probes"."status" != 'passed' OR ("payment_duplicate_probes"."protocol_verified_at" IS NOT NULL AND "payment_duplicate_probes"."backend_verified_at" IS NOT NULL AND "payment_duplicate_probes"."permit_consumed_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE INDEX `payment_duplicate_probes_due_idx` ON `payment_duplicate_probes` (`status`,`next_run_at`);--> statement-breakpoint
CREATE TABLE `payment_retry_grants` (
	`task_id` text PRIMARY KEY NOT NULL,
	`policy` text DEFAULT 'same_order_v1' NOT NULL,
	`parameter_digest` text NOT NULL,
	`max_additional_sends` integer DEFAULT 5 NOT NULL,
	`used_additional_sends` integer DEFAULT 0 NOT NULL,
	`expires_at` integer NOT NULL,
	`revoked_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`task_id`) REFERENCES `payment_tasks`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "payment_retry_grants_policy_valid" CHECK("payment_retry_grants"."policy" = 'same_order_v1'),
	CONSTRAINT "payment_retry_grants_budget_valid" CHECK("payment_retry_grants"."max_additional_sends" BETWEEN 1 AND 5 AND "payment_retry_grants"."used_additional_sends" BETWEEN 0 AND "payment_retry_grants"."max_additional_sends"),
	CONSTRAINT "payment_retry_grants_expiry_valid" CHECK("payment_retry_grants"."expires_at" > "payment_retry_grants"."created_at" AND "payment_retry_grants"."expires_at" <= "payment_retry_grants"."created_at" + 86400000)
);
--> statement-breakpoint
ALTER TABLE `merchants` ADD `manual_check_at` integer;--> statement-breakpoint
ALTER TABLE `payment_attempts` ADD `purpose` text DEFAULT 'recovery' NOT NULL;--> statement-breakpoint
ALTER TABLE `payment_attempts` ADD `diagnostic_ciphertext` text;--> statement-breakpoint
ALTER TABLE `payment_tasks` ADD `next_action` text DEFAULT 'query' NOT NULL;--> statement-breakpoint
ALTER TABLE `payment_tasks` ADD `next_send_at` integer;--> statement-breakpoint
ALTER TABLE `payment_tasks` ADD `next_query_at` integer;--> statement-breakpoint
ALTER TABLE `payment_tasks` ADD `send_backoff_count` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `payment_tasks` ADD `query_backoff_count` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `payment_tasks` ADD `send_block_reason` text;--> statement-breakpoint
ALTER TABLE `payment_tasks` ADD `order_observed_at` integer;--> statement-breakpoint
ALTER TABLE `payment_tasks` ADD `order_evidence` text;--> statement-breakpoint
ALTER TABLE `payment_tasks` ADD `queried_send_count` integer;--> statement-breakpoint
ALTER TABLE `payment_tasks` ADD `recovery_version` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `payment_tasks` ADD `queried_recovery_version` integer;--> statement-breakpoint
ALTER TABLE `payment_tasks` ADD `query_retry_after_at` integer;
--> statement-breakpoint
UPDATE payment_tasks SET next_action=CASE WHEN status IN ('confirmed','attention') THEN 'none' WHEN mode='real' AND attempt_count>0 THEN 'query' WHEN status IN ('pending','waiting') THEN 'send' ELSE 'query' END,
 next_query_at=CASE WHEN status IN ('reconciling','sending') OR (mode='real' AND attempt_count>0 AND status!='confirmed') THEN next_run_at ELSE NULL END,
 order_observed_at=CASE WHEN mode='real' AND external_order_id IS NOT NULL THEN COALESCE(send_acknowledged_at,confirmed_at,updated_at) ELSE NULL END,
 order_evidence=CASE WHEN mode='real' AND external_order_id IS NOT NULL THEN CASE WHEN status='confirmed' THEN 'query' ELSE 'receipt' END ELSE NULL END;
--> statement-breakpoint
CREATE TRIGGER payment_retry_grants_insert_guard BEFORE INSERT ON payment_retry_grants
WHEN NOT EXISTS (SELECT 1 FROM payment_tasks p JOIN payment_acceptances a ON a.id=p.acceptance_id
 WHERE p.id=NEW.task_id AND p.source='acceptance' AND p.mode='real' AND a.send_consumed_at IS NOT NULL)
 OR NEW.used_additional_sends!=0 OR NEW.revoked_at IS NOT NULL
 OR length(NEW.parameter_digest)!=64 OR NEW.parameter_digest GLOB '*[^0-9a-f]*'
BEGIN SELECT RAISE(ABORT, 'retry grant requires an existing real acceptance'); END;
--> statement-breakpoint
CREATE TRIGGER payment_retry_grants_immutable BEFORE UPDATE ON payment_retry_grants
WHEN OLD.task_id IS NOT NEW.task_id OR OLD.policy IS NOT NEW.policy OR OLD.parameter_digest IS NOT NEW.parameter_digest
 OR OLD.max_additional_sends IS NOT NEW.max_additional_sends OR OLD.expires_at IS NOT NEW.expires_at OR OLD.created_at IS NOT NEW.created_at
 OR NEW.used_additional_sends<OLD.used_additional_sends OR NEW.used_additional_sends>OLD.used_additional_sends+1
 OR (OLD.revoked_at IS NOT NULL AND OLD.revoked_at IS NOT NEW.revoked_at)
BEGIN SELECT RAISE(ABORT, 'retry grant identity and consumed budget are immutable'); END;
--> statement-breakpoint
CREATE TRIGGER payment_retry_grants_no_delete BEFORE DELETE ON payment_retry_grants
BEGIN SELECT RAISE(ABORT, 'retry grants cannot be deleted'); END;
--> statement-breakpoint
CREATE TRIGGER payment_duplicate_probes_insert_guard BEFORE INSERT ON payment_duplicate_probes
WHEN NOT EXISTS (SELECT 1 FROM payment_tasks p JOIN payment_retry_grants g ON g.task_id=p.id
 WHERE p.id=NEW.task_id AND p.mode='real' AND p.source='acceptance' AND p.status='confirmed'
 AND p.external_order_id=NEW.baseline_external_order_id AND g.parameter_digest=NEW.parameter_digest)
 OR NEW.status!='pending' OR NEW.permit_consumed_at IS NOT NULL OR NEW.protocol_verified_at IS NOT NULL
 OR NEW.backend_verified_at IS NOT NULL OR NEW.query_count!=0
BEGIN SELECT RAISE(ABORT, 'duplicate probe requires a confirmed matching acceptance'); END;
--> statement-breakpoint
CREATE TRIGGER payment_duplicate_probes_immutable BEFORE UPDATE ON payment_duplicate_probes
WHEN OLD.task_id IS NOT NEW.task_id OR OLD.parameter_digest IS NOT NEW.parameter_digest
 OR OLD.baseline_external_order_id IS NOT NEW.baseline_external_order_id OR OLD.created_at IS NOT NEW.created_at
 OR NEW.query_count<OLD.query_count
 OR (OLD.permit_consumed_at IS NOT NULL AND OLD.permit_consumed_at IS NOT NEW.permit_consumed_at)
 OR (OLD.protocol_verified_at IS NOT NULL AND OLD.protocol_verified_at IS NOT NEW.protocol_verified_at)
 OR (OLD.backend_verified_at IS NOT NULL AND OLD.backend_verified_at IS NOT NEW.backend_verified_at)
 OR (OLD.status IN ('passed','conflict') AND OLD.status IS NOT NEW.status)
BEGIN SELECT RAISE(ABORT, 'duplicate probe identity and consumed permit are immutable'); END;
--> statement-breakpoint
CREATE TRIGGER payment_duplicate_probes_no_delete BEFORE DELETE ON payment_duplicate_probes
BEGIN SELECT RAISE(ABORT, 'duplicate probes cannot be deleted'); END;
--> statement-breakpoint
CREATE TRIGGER payment_tasks_real_evidence_sticky BEFORE UPDATE ON payment_tasks
WHEN OLD.mode='real' AND (
 (OLD.order_observed_at IS NOT NULL AND NEW.order_observed_at IS NULL)
 OR (OLD.order_evidence IS NOT NULL AND NEW.order_evidence IS NULL)
 OR (OLD.external_order_id IS NOT NULL AND OLD.external_order_id IS NOT NEW.external_order_id)
 OR (OLD.unknown_outcome=1 AND NEW.unknown_outcome=0 AND NEW.status!='confirmed')
 OR (OLD.status='confirmed' AND NEW.status!='confirmed')
 OR (OLD.confirmed_at IS NOT NULL AND OLD.confirmed_at IS NOT NEW.confirmed_at))
BEGIN SELECT RAISE(ABORT, 'observed real payment evidence cannot be cleared'); END;
