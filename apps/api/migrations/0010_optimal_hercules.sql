CREATE TABLE `payment_acceptances` (
	`id` text PRIMARY KEY NOT NULL,
	`merchant_id` text NOT NULL,
	`client_id` text NOT NULL,
	`business_no` text NOT NULL,
	`recipient_id` text NOT NULL,
	`recipient_username` text NOT NULL,
	`amount_minor` integer NOT NULL,
	`send_consumed_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`merchant_id`) REFERENCES `merchants`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "payment_acceptances_amount_positive" CHECK(typeof("payment_acceptances"."amount_minor") = 'integer' AND "payment_acceptances"."amount_minor" > 0 AND "payment_acceptances"."amount_minor" <= 9007199254740991)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `payment_acceptances_business_unique` ON `payment_acceptances` (`client_id`,`business_no`);--> statement-breakpoint
PRAGMA defer_foreign_keys=ON;--> statement-breakpoint
CREATE TABLE `__new_payment_tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`claim_id` text,
	`source` text DEFAULT 'claim' NOT NULL,
	`acceptance_id` text,
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
	FOREIGN KEY (`claim_id`) REFERENCES `claims`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`acceptance_id`) REFERENCES `payment_acceptances`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`merchant_id`) REFERENCES `merchants`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "payment_tasks_source_valid" CHECK(("__new_payment_tasks"."source" = 'claim' AND "__new_payment_tasks"."claim_id" IS NOT NULL AND "__new_payment_tasks"."acceptance_id" IS NULL) OR ("__new_payment_tasks"."source" = 'acceptance' AND "__new_payment_tasks"."claim_id" IS NULL AND "__new_payment_tasks"."acceptance_id" IS NOT NULL AND "__new_payment_tasks"."mode" = 'real')),
	CONSTRAINT "payment_tasks_mode_valid" CHECK("__new_payment_tasks"."mode" IN ('simulation','real')),
	CONSTRAINT "payment_tasks_recipient_snapshot" CHECK(("__new_payment_tasks"."mode" = 'simulation' AND "__new_payment_tasks"."recipient_id" LIKE 'simulation:%') OR ("__new_payment_tasks"."mode" = 'real' AND "__new_payment_tasks"."recipient_username" IS NOT NULL AND length("__new_payment_tasks"."recipient_username") > 0 AND "__new_payment_tasks"."recipient_id" GLOB '[1-9]*' AND "__new_payment_tasks"."recipient_id" NOT GLOB '*[^0-9]*' AND length("__new_payment_tasks"."recipient_id") <= 20)),
	CONSTRAINT "payment_tasks_amount_positive" CHECK(typeof("__new_payment_tasks"."amount_minor") = 'integer' AND "__new_payment_tasks"."amount_minor" > 0 AND "__new_payment_tasks"."amount_minor" <= 9007199254740991)
);
--> statement-breakpoint
INSERT INTO `__new_payment_tasks`("id", "claim_id", "source", "acceptance_id", "merchant_id", "client_id", "business_no", "recipient_id", "recipient_username", "amount_minor", "mode", "status", "reason", "external_order_id", "attempt_count", "reconciliation_count", "unknown_outcome", "next_run_at", "created_at", "updated_at", "confirmed_at", "send_acknowledged_at") SELECT "id", "claim_id", 'claim', NULL, "merchant_id", "client_id", "business_no", "recipient_id", "recipient_username", "amount_minor", "mode", "status", "reason", "external_order_id", "attempt_count", "reconciliation_count", "unknown_outcome", "next_run_at", "created_at", "updated_at", "confirmed_at", NULL FROM `payment_tasks`;--> statement-breakpoint
DROP TABLE `payment_tasks`;--> statement-breakpoint
ALTER TABLE `__new_payment_tasks` RENAME TO `payment_tasks`;--> statement-breakpoint
CREATE UNIQUE INDEX `payment_tasks_claim_unique` ON `payment_tasks` (`claim_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `payment_tasks_acceptance_unique` ON `payment_tasks` (`acceptance_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `payment_tasks_business_unique` ON `payment_tasks` (`client_id`,`business_no`);--> statement-breakpoint
CREATE INDEX `payment_tasks_due_idx` ON `payment_tasks` (`status`,`next_run_at`);--> statement-breakpoint
CREATE INDEX `payment_tasks_merchant_active_order_idx` ON `payment_tasks` (`merchant_id`,`created_at`,`id`) WHERE "payment_tasks"."status" IN ('pending','waiting','reconciling','sending');--> statement-breakpoint
CREATE INDEX `payment_tasks_merchant_time_idx` ON `payment_tasks` (`merchant_id`,`created_at`,`id`);--> statement-breakpoint
ALTER TABLE `merchant_credentials` ADD `verification_status` text DEFAULT 'unverified' NOT NULL;--> statement-breakpoint
ALTER TABLE `merchant_credentials` ADD `verification_token` text;--> statement-breakpoint
ALTER TABLE `merchant_credentials` ADD `verification_started_at` integer;--> statement-breakpoint
ALTER TABLE `merchant_credentials` ADD `verification_checked_at` integer;--> statement-breakpoint
ALTER TABLE `merchant_credentials` ADD `verification_next_at` integer;--> statement-breakpoint
ALTER TABLE `merchant_credentials` ADD `verification_reason` text;--> statement-breakpoint
ALTER TABLE `merchant_credentials` ADD `verification_http_status` integer;
--> statement-breakpoint
CREATE TRIGGER payment_tasks_insert_consistency BEFORE INSERT ON payment_tasks
WHEN NOT EXISTS (SELECT 1 FROM merchants WHERE id=NEW.merchant_id AND client_id=NEW.client_id AND mode=NEW.mode)
OR (NEW.source='claim' AND NOT EXISTS (
 SELECT 1 FROM claims c JOIN activities a ON a.id=c.activity_id JOIN reward_inventory r ON r.id=c.inventory_id
 WHERE c.id=NEW.claim_id AND a.reward_type='ldc' AND a.merchant_id=NEW.merchant_id AND a.payment_mode=NEW.mode AND r.amount_minor=NEW.amount_minor
))
OR (NEW.source='acceptance' AND NOT EXISTS (
 SELECT 1 FROM payment_acceptances a WHERE a.id=NEW.acceptance_id AND a.merchant_id=NEW.merchant_id
 AND a.client_id=NEW.client_id AND a.business_no=NEW.business_no AND a.recipient_id=NEW.recipient_id
 AND a.recipient_username=NEW.recipient_username AND a.amount_minor=NEW.amount_minor
))
BEGIN SELECT RAISE(ABORT, 'payment task is inconsistent'); END;
--> statement-breakpoint
CREATE TRIGGER payment_tasks_immutable_identity BEFORE UPDATE ON payment_tasks
WHEN OLD.id IS NOT NEW.id OR OLD.claim_id IS NOT NEW.claim_id OR OLD.source IS NOT NEW.source OR OLD.acceptance_id IS NOT NEW.acceptance_id
 OR OLD.mode IS NOT NEW.mode OR OLD.merchant_id IS NOT NEW.merchant_id OR OLD.client_id IS NOT NEW.client_id
 OR OLD.business_no IS NOT NEW.business_no OR OLD.recipient_id IS NOT NEW.recipient_id
 OR OLD.recipient_username IS NOT NEW.recipient_username OR OLD.amount_minor IS NOT NEW.amount_minor
BEGIN SELECT RAISE(ABORT, 'payment task identity is immutable'); END;
--> statement-breakpoint
CREATE TRIGGER payment_acceptances_immutable BEFORE UPDATE ON payment_acceptances
WHEN OLD.id IS NOT NEW.id OR OLD.merchant_id IS NOT NEW.merchant_id OR OLD.client_id IS NOT NEW.client_id
 OR OLD.business_no IS NOT NEW.business_no OR OLD.recipient_id IS NOT NEW.recipient_id
 OR OLD.recipient_username IS NOT NEW.recipient_username OR OLD.amount_minor IS NOT NEW.amount_minor
 OR OLD.created_at IS NOT NEW.created_at OR (OLD.send_consumed_at IS NOT NULL AND OLD.send_consumed_at IS NOT NEW.send_consumed_at)
BEGIN SELECT RAISE(ABORT, 'acceptance identity and consumed permission are immutable'); END;
--> statement-breakpoint
CREATE TRIGGER payment_acceptances_no_delete BEFORE DELETE ON payment_acceptances
BEGIN SELECT RAISE(ABORT, 'acceptance authorization cannot be deleted'); END;
--> statement-breakpoint
PRAGMA defer_foreign_keys=OFF;
