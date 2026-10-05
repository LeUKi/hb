CREATE TABLE `maintenance_runs` (
	`job` text PRIMARY KEY NOT NULL,
	`scheduled_at` integer NOT NULL,
	`started_at` integer NOT NULL,
	`finished_at` integer,
	`status` text NOT NULL,
	`reason` text,
	CONSTRAINT "maintenance_runs_status" CHECK("maintenance_runs"."status" IN ('running','succeeded','failed'))
);
--> statement-breakpoint
CREATE TABLE `platform_controls` (
	`id` text PRIMARY KEY NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`allow_real_open` integer DEFAULT false NOT NULL,
	`allow_real_claim` integer DEFAULT false NOT NULL,
	`allow_real_send` integer DEFAULT false NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT "platform_controls_singleton" CHECK("platform_controls"."id" = 'global'),
	CONSTRAINT "platform_controls_flags" CHECK("platform_controls"."allow_real_open" IN (0,1) AND "platform_controls"."allow_real_claim" IN (0,1) AND "platform_controls"."allow_real_send" IN (0,1))
);
--> statement-breakpoint
CREATE TABLE `queue_probes` (
	`id` text PRIMARY KEY NOT NULL,
	`requested_at` integer NOT NULL,
	`consumed_at` integer,
	`last_seen_at` integer,
	`delivery_count` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
ALTER TABLE merchants ADD usage_status TEXT NOT NULL DEFAULT 'current' CHECK(usage_status IN ('current','legacy'));
--> statement-breakpoint
-- Retain one current configuration per author; successful real history wins.
UPDATE merchants SET usage_status='legacy' WHERE id NOT IN (
 SELECT id FROM (
  SELECT m.id, ROW_NUMBER() OVER (PARTITION BY m.author_id ORDER BY
   CASE WHEN m.mode='real' AND EXISTS(SELECT 1 FROM payment_tasks p WHERE p.merchant_id=m.id AND p.status='confirmed') THEN 0
        WHEN m.mode='real' AND EXISTS(SELECT 1 FROM merchant_credentials c WHERE c.merchant_id=m.id AND c.version=m.credential_version AND c.verification_status='passed') THEN 1
        ELSE 2 END, m.created_at, m.id) AS position
  FROM merchants m
 ) WHERE position=1
);
--> statement-breakpoint
CREATE UNIQUE INDEX merchants_author_current_unique ON merchants(author_id) WHERE usage_status='current';
--> statement-breakpoint
ALTER TABLE `payment_tasks` ADD `recovery_policy` text;--> statement-breakpoint
ALTER TABLE `payment_tasks` ADD `parameter_digest` text;--> statement-breakpoint
ALTER TABLE `payment_tasks` ADD `first_send_at` integer;
--> statement-breakpoint
INSERT INTO platform_controls(id,updated_at) VALUES ('global',CAST(unixepoch('now') * 1000 AS INTEGER));
--> statement-breakpoint
CREATE TRIGGER platform_controls_version_guard BEFORE UPDATE ON platform_controls
WHEN NEW.id IS NOT OLD.id OR NEW.version != OLD.version + 1
BEGIN SELECT RAISE(ABORT, 'platform control version must advance'); END;
--> statement-breakpoint
CREATE TRIGGER platform_controls_no_replace BEFORE INSERT ON platform_controls
WHEN EXISTS(SELECT 1 FROM platform_controls WHERE id=NEW.id)
BEGIN SELECT RAISE(ABORT, 'platform controls cannot be replaced'); END;
--> statement-breakpoint
CREATE TRIGGER platform_controls_no_delete BEFORE DELETE ON platform_controls
BEGIN SELECT RAISE(ABORT, 'platform controls cannot be deleted'); END;
--> statement-breakpoint
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
)) OR ((NEW.source!='claim' OR NEW.mode!='real') AND (NEW.recovery_policy IS NOT NULL OR NEW.parameter_digest IS NOT NULL OR NEW.first_send_at IS NOT NULL))
BEGIN SELECT RAISE(ABORT, 'ordinary payment authorization mismatch'); END;
--> statement-breakpoint
CREATE TRIGGER payment_claim_policy_immutable BEFORE UPDATE ON payment_tasks
WHEN NEW.recovery_policy IS NOT OLD.recovery_policy OR NEW.parameter_digest IS NOT OLD.parameter_digest
 OR (OLD.first_send_at IS NOT NULL AND NEW.first_send_at IS NOT OLD.first_send_at)
 OR (NEW.first_send_at IS NOT NULL AND (NEW.source!='claim' OR NEW.mode!='real' OR NEW.recovery_policy IS NOT 'claim_same_order_v1'))
BEGIN SELECT RAISE(ABORT, 'ordinary payment authorization is immutable'); END;
