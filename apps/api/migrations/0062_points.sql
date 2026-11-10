-- 三方积分 (docs/third-party-points-design.md, 2026-11-10): other sites'
-- points as a third way to fund a 红包. Its systems, their words' changes,
-- self-tests, the senders' keys, each payout and each call to an issuer,
-- the site switch (off). A 红包 funded so names its system; the funding
-- triggers take the third kind (no table rebuilt).
CREATE TABLE `points_calls` (
	`id` text PRIMARY KEY NOT NULL,
	`system_id` text NOT NULL,
	`kind` text NOT NULL,
	`result` text NOT NULL,
	`http_status` integer,
	`ms` integer NOT NULL,
	`payment_id` text,
	`at` integer NOT NULL,
	FOREIGN KEY (`system_id`) REFERENCES `points_systems`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `points_calls_system_time_idx` ON `points_calls` (`system_id`,`at`);--> statement-breakpoint
CREATE INDEX `points_calls_time_idx` ON `points_calls` (`at`);--> statement-breakpoint
CREATE TABLE `points_copy_changes` (
	`id` text PRIMARY KEY NOT NULL,
	`system_id` text NOT NULL,
	`actor_id` text NOT NULL,
	`field` text NOT NULL,
	`before` text NOT NULL,
	`after` text NOT NULL,
	`created_at` integer NOT NULL,
	`seen_at` integer,
	FOREIGN KEY (`system_id`) REFERENCES `points_systems`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`actor_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `points_copy_changes_system_idx` ON `points_copy_changes` (`system_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `points_copy_changes_unseen_idx` ON `points_copy_changes` (`created_at`) WHERE "points_copy_changes"."seen_at" IS NULL;--> statement-breakpoint
CREATE TABLE `points_keys` (
	`id` text PRIMARY KEY NOT NULL,
	`system_id` text NOT NULL,
	`author_id` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`ciphertext` text NOT NULL,
	`account_id` text,
	`account_username` text,
	`status` text NOT NULL,
	`checked_at` integer NOT NULL,
	`removed_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`system_id`) REFERENCES `points_systems`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`author_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `points_keys_owner_unique` ON `points_keys` (`system_id`,`author_id`) WHERE "points_keys"."removed_at" IS NULL;--> statement-breakpoint
CREATE INDEX `points_keys_author_idx` ON `points_keys` (`author_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `points_payments` (
	`id` text PRIMARY KEY NOT NULL,
	`claim_id` text NOT NULL,
	`activity_id` text NOT NULL,
	`system_id` text NOT NULL,
	`author_id` text NOT NULL,
	`recipient_user_id` text NOT NULL,
	`recipient_external_id` text NOT NULL,
	`recipient_username` text NOT NULL,
	`amount_minor` integer NOT NULL,
	`out_trade_no` text NOT NULL,
	`status` text NOT NULL,
	`reason` text,
	`trade_no` text,
	`misses` integer DEFAULT 0 NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`resend_count` integer DEFAULT 0 NOT NULL,
	`resend_until` integer,
	`next_run_at` integer,
	`query_first` integer DEFAULT false NOT NULL,
	`lease_token` text,
	`lease_until` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`done_at` integer,
	FOREIGN KEY (`claim_id`) REFERENCES `claims`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`activity_id`) REFERENCES `activities`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`system_id`) REFERENCES `points_systems`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`author_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`recipient_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "points_payments_valid" CHECK("points_payments"."amount_minor" > 0
        AND "points_payments"."status" IN ('pending','sending','confirmed','held','unknown','failed')
        AND ("points_payments"."status" = 'confirmed') = ("points_payments"."trade_no" IS NOT NULL)
        AND "points_payments"."misses" BETWEEN 0 AND 3
        AND "points_payments"."resend_count" BETWEEN 0 AND 1)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `points_payments_claim_unique` ON `points_payments` (`claim_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `points_payments_trade_unique` ON `points_payments` (`out_trade_no`);--> statement-breakpoint
CREATE INDEX `points_payments_due_idx` ON `points_payments` (`next_run_at`) WHERE "points_payments"."next_run_at" IS NOT NULL;--> statement-breakpoint
CREATE INDEX `points_payments_activity_idx` ON `points_payments` (`activity_id`,`status`);--> statement-breakpoint
CREATE INDEX `points_payments_system_idx` ON `points_payments` (`system_id`,`status`,`updated_at`);--> statement-breakpoint
CREATE INDEX `points_payments_author_idx` ON `points_payments` (`author_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `points_self_tests` (
	`id` text PRIMARY KEY NOT NULL,
	`system_id` text NOT NULL,
	`started_by` text NOT NULL,
	`endpoint_version` integer NOT NULL,
	`base_url` text NOT NULL,
	`step` integer NOT NULL,
	`status` text NOT NULL,
	`steps` text DEFAULT '[]' NOT NULL,
	`started_at` integer NOT NULL,
	`finished_at` integer,
	FOREIGN KEY (`system_id`) REFERENCES `points_systems`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`started_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `points_self_tests_system_idx` ON `points_self_tests` (`system_id`,`started_at`);--> statement-breakpoint
CREATE TABLE `points_settings` (
	`id` text PRIMARY KEY NOT NULL,
	`enabled` integer DEFAULT false NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`updated_by` text,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`updated_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "points_settings_singleton" CHECK("points_settings"."id" = 'global')
);
--> statement-breakpoint
CREATE TABLE `points_systems` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`status` text NOT NULL,
	`name` text NOT NULL,
	`unit` text NOT NULL,
	`step` integer NOT NULL,
	`issuer_name` text NOT NULL,
	`base_url` text NOT NULL,
	`host` text NOT NULL,
	`intro` text DEFAULT '' NOT NULL,
	`key_guide` text DEFAULT '' NOT NULL,
	`no_recipient` text DEFAULT '' NOT NULL,
	`arrival` text DEFAULT '' NOT NULL,
	`not_allowed` text DEFAULT '' NOT NULL,
	`insufficient` text DEFAULT '' NOT NULL,
	`key_invalid` text DEFAULT '' NOT NULL,
	`rate` integer DEFAULT 10 NOT NULL,
	`endpoint_version` integer DEFAULT 1 NOT NULL,
	`test_key_ciphertext` text,
	`test_key_version` integer DEFAULT 0 NOT NULL,
	`test_recipient_id` text,
	`passed_test_id` text,
	`passed_endpoint_version` integer,
	`last_test_started_at` integer,
	`submitted_at` integer,
	`reviewed_at` integer,
	`reviewed_by` text,
	`review_note` text,
	`online_at` integer,
	`paused_by` text,
	`paused_at` integer,
	`retired_at` integer,
	`missed_in_row` integer DEFAULT 0 NOT NULL,
	`breaker_until` integer,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`owner_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`reviewed_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "points_systems_valid" CHECK("points_systems"."status" IN ('draft','reviewing','online','paused','retired')
        AND "points_systems"."step" BETWEEN 1 AND 10000000000
        AND "points_systems"."rate" BETWEEN 1 AND 100
        AND "points_systems"."version" >= 1 AND "points_systems"."endpoint_version" >= 1
        AND length("points_systems"."base_url") BETWEEN 9 AND 200
        AND ("points_systems"."base_url" LIKE 'https://%' OR "points_systems"."base_url" LIKE 'http://127.0.0.1:%'))
);
--> statement-breakpoint
CREATE INDEX `points_systems_owner_idx` ON `points_systems` (`owner_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `points_systems_status_idx` ON `points_systems` (`status`,`updated_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `points_systems_name_unique` ON `points_systems` (lower("name")) WHERE "points_systems"."status" <> 'retired';--> statement-breakpoint
ALTER TABLE `activities` ADD `points_system_id` text REFERENCES points_systems(id);--> statement-breakpoint
ALTER TABLE `activities` ADD `points_stop_reason` text;--> statement-breakpoint
INSERT INTO `points_settings` (`id`,`enabled`,`version`,`updated_at`) VALUES ('global',0,1,0);--> statement-breakpoint
DROP TRIGGER activities_funding_insert_valid;--> statement-breakpoint
DROP TRIGGER activities_funding_update_valid;--> statement-breakpoint
-- 商户直发, 🐟额 (no merchant) or 三方积分 (no merchant, its system named),
-- fixed once the 红包 opens.
CREATE TRIGGER activities_funding_insert_valid
BEFORE INSERT ON activities
WHEN NEW.funding NOT IN ('merchant','balance','points')
  OR (NEW.funding='balance' AND (NEW.merchant_id IS NOT NULL OR NEW.reward_type!='ldc'))
  OR (NEW.funding='points' AND (NEW.merchant_id IS NOT NULL OR NEW.reward_type!='ldc' OR NEW.points_system_id IS NULL))
  OR (NEW.funding!='points' AND NEW.points_system_id IS NOT NULL)
BEGIN
  SELECT RAISE(ABORT, 'activity funding invalid');
END;--> statement-breakpoint
CREATE TRIGGER activities_funding_update_valid
BEFORE UPDATE OF funding, merchant_id, points_system_id ON activities
WHEN NEW.funding NOT IN ('merchant','balance','points')
  OR (NEW.funding='balance' AND NEW.merchant_id IS NOT NULL)
  OR (NEW.funding='points' AND (NEW.merchant_id IS NOT NULL OR NEW.points_system_id IS NULL))
  OR (NEW.funding!='points' AND NEW.points_system_id IS NOT NULL)
  OR (OLD.opened_at IS NOT NULL AND (NEW.funding IS NOT OLD.funding OR NEW.points_system_id IS NOT OLD.points_system_id))
BEGIN
  SELECT RAISE(ABORT, 'activity funding invalid');
END;--> statement-breakpoint
-- A payout belongs to its claim's 三方积分红包 and to the claimer, never
-- the author (自领 pays nothing), for exactly the claim's amount.
CREATE TRIGGER points_payments_insert_consistency
BEFORE INSERT ON points_payments
WHEN NOT EXISTS (
  SELECT 1 FROM claims c
  JOIN activities a ON a.id=c.activity_id
  JOIN reward_inventory r ON r.id=c.inventory_id AND r.activity_id=c.activity_id
  JOIN users u ON u.id=c.user_id
  WHERE c.id=NEW.claim_id AND a.id=NEW.activity_id AND a.funding='points'
    AND a.points_system_id=NEW.system_id AND a.author_id=NEW.author_id
    AND c.user_id=NEW.recipient_user_id AND c.user_id!=a.author_id
    AND u.external_id=NEW.recipient_external_id
    AND r.amount_minor=NEW.amount_minor)
BEGIN
  SELECT RAISE(ABORT, 'points payment does not match its claim');
END;--> statement-breakpoint
CREATE TRIGGER points_payments_identity_immutable
BEFORE UPDATE OF claim_id, activity_id, system_id, author_id, recipient_user_id, recipient_external_id, amount_minor, out_trade_no ON points_payments
BEGIN
  SELECT RAISE(ABORT, 'points payment identity is immutable');
END;--> statement-breakpoint
-- confirmed and failed are final; a confirmed one keeps its order.
CREATE TRIGGER points_payments_final
BEFORE UPDATE ON points_payments
WHEN OLD.status IN ('confirmed','failed') AND (NEW.status IS NOT OLD.status OR NEW.trade_no IS NOT OLD.trade_no)
BEGIN
  SELECT RAISE(ABORT, 'points payment is final');
END;
