CREATE TABLE `balance_accounts` (
	`user_id` text PRIMARY KEY NOT NULL,
	`available_minor` integer DEFAULT 0 NOT NULL,
	`locked_minor` integer DEFAULT 0 NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "balance_accounts_locked_valid" CHECK("balance_accounts"."locked_minor" >= 0)
);
--> statement-breakpoint
CREATE TABLE `balance_adjustments` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`direction` text NOT NULL,
	`amount_minor` integer NOT NULL,
	`reason` text NOT NULL,
	`actor_user_id` text NOT NULL,
	`request_id` text NOT NULL,
	`request_digest` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "balance_adjustments_valid" CHECK("balance_adjustments"."direction" IN ('add','deduct') AND "balance_adjustments"."amount_minor" > 0 AND length("balance_adjustments"."reason") BETWEEN 1 AND 200)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `balance_adjustments_request_unique` ON `balance_adjustments` (`request_id`);--> statement-breakpoint
CREATE INDEX `balance_adjustments_user_time_idx` ON `balance_adjustments` (`user_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `balance_adjustments_time_idx` ON `balance_adjustments` (`created_at`,`id`);--> statement-breakpoint
CREATE TABLE `balance_entries` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`kind` text NOT NULL,
	`available_delta_minor` integer NOT NULL,
	`locked_delta_minor` integer DEFAULT 0 NOT NULL,
	`topup_id` text,
	`adjustment_id` text,
	`lock_id` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`topup_id`) REFERENCES `balance_topups`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`adjustment_id`) REFERENCES `balance_adjustments`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "balance_entries_shape_valid" CHECK(("balance_entries"."kind" = 'topup' AND "balance_entries"."topup_id" IS NOT NULL AND "balance_entries"."available_delta_minor" > 0 AND "balance_entries"."locked_delta_minor" = 0)
        OR ("balance_entries"."kind" = 'adjustment' AND "balance_entries"."adjustment_id" IS NOT NULL AND "balance_entries"."available_delta_minor" != 0 AND "balance_entries"."locked_delta_minor" = 0)
        OR ("balance_entries"."kind" = 'lock' AND "balance_entries"."lock_id" IS NOT NULL AND "balance_entries"."available_delta_minor" < 0 AND "balance_entries"."locked_delta_minor" = -"balance_entries"."available_delta_minor")
        OR ("balance_entries"."kind" = 'unlock' AND "balance_entries"."lock_id" IS NOT NULL AND "balance_entries"."available_delta_minor" > 0 AND "balance_entries"."locked_delta_minor" = -"balance_entries"."available_delta_minor")
        OR ("balance_entries"."kind" = 'deduct' AND "balance_entries"."lock_id" IS NOT NULL AND "balance_entries"."available_delta_minor" = 0 AND "balance_entries"."locked_delta_minor" < 0))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `balance_entries_topup_unique` ON `balance_entries` (`topup_id`) WHERE "balance_entries"."kind" = 'topup';--> statement-breakpoint
CREATE UNIQUE INDEX `balance_entries_adjustment_unique` ON `balance_entries` (`adjustment_id`) WHERE "balance_entries"."kind" = 'adjustment';--> statement-breakpoint
CREATE INDEX `balance_entries_user_time_idx` ON `balance_entries` (`user_id`,`created_at`,`id`);--> statement-breakpoint
CREATE TABLE `balance_setting_changes` (
	`id` text PRIMARY KEY NOT NULL,
	`actor_user_id` text NOT NULL,
	`previous_version` integer NOT NULL,
	`next_version` integer NOT NULL,
	`previous` text NOT NULL,
	`next` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `balance_setting_changes_version_unique` ON `balance_setting_changes` (`next_version`);--> statement-breakpoint
CREATE INDEX `balance_setting_changes_time_idx` ON `balance_setting_changes` (`created_at`,`id`);--> statement-breakpoint
CREATE TABLE `balance_settings` (
	`id` text PRIMARY KEY NOT NULL,
	`version` integer NOT NULL,
	`topup_enabled` integer DEFAULT false NOT NULL,
	`withdraw_enabled` integer DEFAULT false NOT NULL,
	`topup_fee_percent` integer DEFAULT 12 NOT NULL,
	`withdraw_fee_percent` integer DEFAULT 12 NOT NULL,
	`withdraw_max_minor` integer DEFAULT 100000 NOT NULL,
	`allowlist_enabled` integer DEFAULT true NOT NULL,
	`allowlist` text DEFAULT '[]' NOT NULL,
	`updated_at` integer NOT NULL,
	`updated_by_user_id` text,
	CONSTRAINT "balance_settings_singleton" CHECK("balance_settings"."id" = 'global'),
	CONSTRAINT "balance_settings_fees_valid" CHECK("balance_settings"."topup_fee_percent" BETWEEN 0 AND 50 AND "balance_settings"."withdraw_fee_percent" BETWEEN 0 AND 50),
	CONSTRAINT "balance_settings_withdraw_max_valid" CHECK("balance_settings"."withdraw_max_minor" >= 100),
	CONSTRAINT "balance_settings_allowlist_valid" CHECK(json_valid("balance_settings"."allowlist") AND json_type("balance_settings"."allowlist") = 'array')
);
--> statement-breakpoint
CREATE TABLE `balance_topup_checks` (
	`id` text PRIMARY KEY NOT NULL,
	`topup_id` text NOT NULL,
	`trigger` text NOT NULL,
	`result` text NOT NULL,
	`http_status` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`topup_id`) REFERENCES `balance_topups`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `balance_topup_checks_topup_idx` ON `balance_topup_checks` (`topup_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `balance_topups` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`merchant_id` text NOT NULL,
	`client_id` text NOT NULL,
	`credential_version` integer NOT NULL,
	`business_no` text NOT NULL,
	`debit_minor` integer NOT NULL,
	`fee_minor` integer NOT NULL,
	`credit_minor` integer NOT NULL,
	`fee_percent` integer NOT NULL,
	`settings_version` integer NOT NULL,
	`order_name` text NOT NULL,
	`return_url` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`flag` text,
	`external_order_id` text,
	`request_id` text NOT NULL,
	`request_digest` text NOT NULL,
	`created_at` integer NOT NULL,
	`submitted_at` integer,
	`credited_at` integer,
	`credited_by` text,
	`credited_by_user_id` text,
	`credit_reason` text,
	`last_checked_at` integer,
	`last_check_result` text,
	`check_claimed_at` integer DEFAULT 0 NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`merchant_id`) REFERENCES `merchants`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "balance_topups_amounts_valid" CHECK("balance_topups"."debit_minor" BETWEEN 100 AND 200000 AND "balance_topups"."fee_minor" >= 0 AND "balance_topups"."credit_minor" > 0 AND "balance_topups"."debit_minor" = "balance_topups"."credit_minor" + "balance_topups"."fee_minor" AND "balance_topups"."fee_percent" BETWEEN 0 AND 50),
	CONSTRAINT "balance_topups_status_valid" CHECK("balance_topups"."status" IN ('pending','unpaid','credited') AND ("balance_topups"."flag" IS NULL OR "balance_topups"."flag" IN ('mismatch','reversed'))),
	CONSTRAINT "balance_topups_credited_valid" CHECK(("balance_topups"."status" = 'credited') = ("balance_topups"."credited_at" IS NOT NULL AND "balance_topups"."credited_by" IN ('auto','admin')))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `balance_topups_business_no_unique` ON `balance_topups` (`business_no`);--> statement-breakpoint
CREATE UNIQUE INDEX `balance_topups_request_unique` ON `balance_topups` (`user_id`,`request_id`);--> statement-breakpoint
CREATE INDEX `balance_topups_user_time_idx` ON `balance_topups` (`user_id`,`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `balance_topups_status_time_idx` ON `balance_topups` (`status`,`created_at`);--> statement-breakpoint
DROP INDEX `merchants_author_current_unique`;--> statement-breakpoint
ALTER TABLE `merchants` ADD `kind` text DEFAULT 'author' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `merchants_platform_current_unique` ON `merchants` (`kind`) WHERE "merchants"."usage_status" = 'current' AND "merchants"."kind" = 'platform';--> statement-breakpoint
CREATE UNIQUE INDEX `merchants_author_current_unique` ON `merchants` (`author_id`) WHERE "merchants"."usage_status" = 'current' AND "merchants"."kind" = 'author';--> statement-breakpoint
-- 站内🐟额 (docs/balance-design.md). Off until an admin opens it, to the
-- allowlist first.
INSERT INTO balance_settings (id, version, updated_at)
VALUES ('global', 1, CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER));--> statement-breakpoint
-- The platform app is a merchant of its own kind, and stays that kind.
CREATE TRIGGER merchants_kind_insert_valid
BEFORE INSERT ON merchants
WHEN NEW.kind NOT IN ('author','platform')
BEGIN
  SELECT RAISE(ABORT, 'merchant kind invalid');
END;--> statement-breakpoint
CREATE TRIGGER merchants_kind_immutable
BEFORE UPDATE OF kind ON merchants
WHEN NEW.kind IS NOT OLD.kind
BEGIN
  SELECT RAISE(ABORT, 'merchant kind immutable');
END;--> statement-breakpoint
-- Entries are the 🐟额: written once, never changed or removed, and the only
-- way an account moves. Only an admin's 扣回 may take 可用 below 0.
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
CREATE TRIGGER balance_adjustments_immutable
BEFORE UPDATE ON balance_adjustments
BEGIN
  SELECT RAISE(ABORT, 'balance adjustments are append-only');
END;--> statement-breakpoint
CREATE TRIGGER balance_adjustments_permanent
BEFORE DELETE ON balance_adjustments
BEGIN
  SELECT RAISE(ABORT, 'balance adjustments are append-only');
END;--> statement-breakpoint
CREATE TRIGGER balance_topup_checks_immutable
BEFORE UPDATE ON balance_topup_checks
BEGIN
  SELECT RAISE(ABORT, 'topup checks are append-only');
END;--> statement-breakpoint
CREATE TRIGGER balance_topup_checks_permanent
BEFORE DELETE ON balance_topup_checks
BEGIN
  SELECT RAISE(ABORT, 'topup checks are append-only');
END;--> statement-breakpoint
CREATE TRIGGER balance_setting_changes_immutable
BEFORE UPDATE ON balance_setting_changes
BEGIN
  SELECT RAISE(ABORT, 'balance setting changes are append-only');
END;--> statement-breakpoint
-- A 转入 is fixed when it is made: what was sent to Credit, and for how much.
-- 已到账 is final.
CREATE TRIGGER balance_topups_identity_immutable
BEFORE UPDATE ON balance_topups
WHEN NEW.user_id IS NOT OLD.user_id OR NEW.merchant_id IS NOT OLD.merchant_id
  OR NEW.client_id IS NOT OLD.client_id OR NEW.credential_version IS NOT OLD.credential_version
  OR NEW.business_no IS NOT OLD.business_no OR NEW.debit_minor IS NOT OLD.debit_minor
  OR NEW.fee_minor IS NOT OLD.fee_minor OR NEW.credit_minor IS NOT OLD.credit_minor
  OR NEW.fee_percent IS NOT OLD.fee_percent OR NEW.order_name IS NOT OLD.order_name
  OR NEW.return_url IS NOT OLD.return_url OR NEW.request_id IS NOT OLD.request_id
  OR NEW.created_at IS NOT OLD.created_at
  OR (OLD.external_order_id IS NOT NULL AND NEW.external_order_id IS NOT OLD.external_order_id)
BEGIN
  SELECT RAISE(ABORT, 'topup identity immutable');
END;--> statement-breakpoint
CREATE TRIGGER balance_topups_credited_final
BEFORE UPDATE OF status ON balance_topups
WHEN OLD.status = 'credited' AND NEW.status != 'credited'
BEGIN
  SELECT RAISE(ABORT, 'credited topup is final');
END;--> statement-breakpoint
CREATE TRIGGER balance_topups_permanent
BEFORE DELETE ON balance_topups
BEGIN
  SELECT RAISE(ABORT, 'topups are permanent');
END;
