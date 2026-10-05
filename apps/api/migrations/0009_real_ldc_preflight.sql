ALTER TABLE `activities` ADD `payment_mode` text;--> statement-breakpoint
UPDATE `activities` SET `payment_mode` = 'simulation' WHERE `reward_type` = 'ldc';--> statement-breakpoint
PRAGMA defer_foreign_keys=ON;--> statement-breakpoint
CREATE TABLE `__new_merchants` (
	`id` text PRIMARY KEY NOT NULL,
	`author_id` text NOT NULL,
	`request_id` text NOT NULL,
	`request_digest` text NOT NULL,
	`client_id` text NOT NULL,
	`label` text NOT NULL,
	`mode` text DEFAULT 'simulation' NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`credential_version` integer DEFAULT 1 NOT NULL,
	`paused_reason` text,
	`recovery_scanned_at` integer DEFAULT 0 NOT NULL,
	`active_task_id` text,
	`lease_token` text,
	`lease_until` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`author_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "merchants_mode_valid" CHECK("__new_merchants"."mode" IN ('simulation','real'))
);
--> statement-breakpoint
INSERT INTO `__new_merchants` ("id","author_id","request_id","request_digest","client_id","label","mode","version","credential_version","paused_reason","recovery_scanned_at","active_task_id","lease_token","lease_until","created_at","updated_at")
SELECT "id","author_id","request_id","request_digest","client_id","label","mode","version","credential_version","paused_reason","recovery_scanned_at","active_task_id","lease_token","lease_until","created_at","updated_at" FROM `merchants`;--> statement-breakpoint
DROP TABLE `merchants`;--> statement-breakpoint
ALTER TABLE `__new_merchants` RENAME TO `merchants`;--> statement-breakpoint
CREATE UNIQUE INDEX `merchants_client_unique` ON `merchants` (`client_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `merchants_author_request_unique` ON `merchants` (`author_id`,`request_id`);--> statement-breakpoint
CREATE INDEX `merchants_author_created_idx` ON `merchants` (`author_id`,`created_at`,`id`);--> statement-breakpoint
CREATE TABLE `__new_payment_tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`claim_id` text NOT NULL,
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
	FOREIGN KEY (`claim_id`) REFERENCES `claims`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`merchant_id`) REFERENCES `merchants`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "payment_tasks_mode_valid" CHECK("__new_payment_tasks"."mode" IN ('simulation','real')),
	CONSTRAINT "payment_tasks_recipient_snapshot" CHECK("__new_payment_tasks"."mode" = 'simulation' OR "__new_payment_tasks"."recipient_username" IS NOT NULL),
	CONSTRAINT "payment_tasks_amount_positive" CHECK("__new_payment_tasks"."amount_minor" > 0 AND "__new_payment_tasks"."amount_minor" <= 9007199254740991)
);
--> statement-breakpoint
INSERT INTO `__new_payment_tasks` ("id","claim_id","merchant_id","client_id","business_no","recipient_id","recipient_username","amount_minor","mode","status","reason","external_order_id","attempt_count","reconciliation_count","unknown_outcome","next_run_at","created_at","updated_at","confirmed_at")
SELECT "id","claim_id","merchant_id","client_id","business_no","recipient_id",NULL,"amount_minor","mode","status","reason","external_order_id","attempt_count","reconciliation_count","unknown_outcome","next_run_at","created_at","updated_at","confirmed_at" FROM `payment_tasks`;--> statement-breakpoint
DROP TABLE `payment_tasks`;--> statement-breakpoint
ALTER TABLE `__new_payment_tasks` RENAME TO `payment_tasks`;--> statement-breakpoint
CREATE UNIQUE INDEX `payment_tasks_claim_unique` ON `payment_tasks` (`claim_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `payment_tasks_business_unique` ON `payment_tasks` (`client_id`,`business_no`);--> statement-breakpoint
CREATE INDEX `payment_tasks_due_idx` ON `payment_tasks` (`status`,`next_run_at`);--> statement-breakpoint
CREATE INDEX `payment_tasks_merchant_time_idx` ON `payment_tasks` (`merchant_id`,`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `payment_tasks_merchant_active_order_idx` ON `payment_tasks` (`merchant_id`,`created_at`,`id`) WHERE "payment_tasks"."status" IN ('pending','waiting','reconciling','sending');--> statement-breakpoint
ALTER TABLE `payment_attempts` RENAME TO `__old_payment_attempts`;--> statement-breakpoint
CREATE TABLE `payment_attempts` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`token` text NOT NULL,
	`operation` text NOT NULL,
	`outcome` text NOT NULL,
	`reason` text,
	`credential_version` integer NOT NULL,
	`started_at` integer NOT NULL,
	`finished_at` integer,
	FOREIGN KEY (`task_id`) REFERENCES `payment_tasks`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `payment_attempts` ("id","task_id","token","operation","outcome","reason","credential_version","started_at","finished_at")
SELECT "id","task_id","token","operation","outcome","reason","credential_version","started_at","finished_at" FROM `__old_payment_attempts`;--> statement-breakpoint
DROP TABLE `__old_payment_attempts`;--> statement-breakpoint
CREATE INDEX `payment_attempts_task_time_idx` ON `payment_attempts` (`task_id`,`started_at`);--> statement-breakpoint
ALTER TABLE `payment_outbox` RENAME TO `__old_payment_outbox`;--> statement-breakpoint
CREATE TABLE `payment_outbox` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`delivered_at` integer,
	FOREIGN KEY (`task_id`) REFERENCES `payment_tasks`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `payment_outbox` ("id","task_id","created_at","delivered_at")
SELECT "id","task_id","created_at","delivered_at" FROM `__old_payment_outbox`;--> statement-breakpoint
DROP TABLE `__old_payment_outbox`;--> statement-breakpoint
CREATE UNIQUE INDEX `payment_outbox_task_unique` ON `payment_outbox` (`task_id`);--> statement-breakpoint
CREATE INDEX `payment_outbox_delivery_idx` ON `payment_outbox` (`delivered_at`,`created_at`);--> statement-breakpoint
CREATE TRIGGER `merchants_mode_immutable` BEFORE UPDATE OF `mode` ON `merchants`
WHEN OLD.`mode` IS NOT NEW.`mode`
BEGIN
	SELECT RAISE(ABORT, 'merchant mode is immutable');
END;
--> statement-breakpoint
CREATE TRIGGER `merchants_identity_immutable` BEFORE UPDATE OF `author_id`, `client_id` ON `merchants`
WHEN OLD.`author_id` IS NOT NEW.`author_id`
	OR OLD.`client_id` IS NOT NEW.`client_id`
BEGIN
	SELECT RAISE(ABORT, 'merchant identity is immutable');
END;
--> statement-breakpoint
CREATE TRIGGER `activities_payment_mode_valid_insert` BEFORE INSERT ON `activities`
WHEN NEW.`payment_mode` NOT IN ('simulation','real')
	OR (NEW.`reward_type` = 'ldc' AND NEW.`payment_mode` IS NULL)
BEGIN
	SELECT RAISE(ABORT, 'activity payment mode is invalid');
END;
--> statement-breakpoint
CREATE TRIGGER `activities_payment_mode_valid_update` BEFORE UPDATE OF `reward_type`, `payment_mode` ON `activities`
WHEN NEW.`payment_mode` NOT IN ('simulation','real')
	OR (NEW.`reward_type` = 'ldc' AND NEW.`payment_mode` IS NULL)
BEGIN
	SELECT RAISE(ABORT, 'activity payment mode is invalid');
END;
--> statement-breakpoint
CREATE TRIGGER `activities_payment_mode_immutable` BEFORE UPDATE OF `payment_mode` ON `activities`
WHEN OLD.`payment_mode` IS NOT NULL AND OLD.`payment_mode` IS NOT NEW.`payment_mode`
BEGIN
	SELECT RAISE(ABORT, 'activity payment mode is immutable');
END;
--> statement-breakpoint
CREATE TRIGGER `payment_tasks_insert_consistency` BEFORE INSERT ON `payment_tasks`
WHEN NOT EXISTS (
		SELECT 1 FROM `merchants`
		WHERE `id` = NEW.`merchant_id`
			AND `client_id` = NEW.`client_id`
			AND `mode` = NEW.`mode`
	)
	OR NOT EXISTS (
		SELECT 1
		FROM `claims` c
		JOIN `activities` a ON a.`id` = c.`activity_id`
		WHERE c.`id` = NEW.`claim_id`
			AND a.`reward_type` = 'ldc'
			AND a.`merchant_id` = NEW.`merchant_id`
			AND a.`payment_mode` = NEW.`mode`
	)
	OR typeof(NEW.`amount_minor`) != 'integer'
	OR NEW.`amount_minor` <= 0
	OR NEW.`amount_minor` > 9007199254740991
	OR (NEW.`mode` = 'simulation' AND NEW.`recipient_id` NOT LIKE 'simulation:%')
	OR (NEW.`mode` = 'real' AND (
		NEW.`recipient_username` IS NULL
		OR length(NEW.`recipient_username`) = 0
		OR NEW.`recipient_id` NOT GLOB '[1-9]*'
		OR NEW.`recipient_id` GLOB '*[^0-9]*'
		OR length(NEW.`recipient_id`) > 20
	))
BEGIN
	SELECT RAISE(ABORT, 'payment task is inconsistent');
END;
--> statement-breakpoint
CREATE TRIGGER `payment_tasks_immutable_identity` BEFORE UPDATE OF `mode`, `merchant_id`, `client_id`, `business_no`, `recipient_id`, `recipient_username`, `amount_minor` ON `payment_tasks`
WHEN OLD.`mode` IS NOT NEW.`mode`
	OR OLD.`merchant_id` IS NOT NEW.`merchant_id`
	OR OLD.`client_id` IS NOT NEW.`client_id`
	OR OLD.`business_no` IS NOT NEW.`business_no`
	OR OLD.`recipient_id` IS NOT NEW.`recipient_id`
	OR OLD.`recipient_username` IS NOT NEW.`recipient_username`
	OR OLD.`amount_minor` IS NOT NEW.`amount_minor`
BEGIN
	SELECT RAISE(ABORT, 'payment task identity is immutable');
END;
--> statement-breakpoint
PRAGMA defer_foreign_keys=OFF;
