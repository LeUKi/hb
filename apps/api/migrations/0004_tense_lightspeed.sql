CREATE TABLE `merchant_credentials` (
	`id` text PRIMARY KEY NOT NULL,
	`merchant_id` text NOT NULL,
	`version` integer NOT NULL,
	`ciphertext` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`merchant_id`) REFERENCES `merchants`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `merchant_credentials_version_unique` ON `merchant_credentials` (`merchant_id`,`version`);--> statement-breakpoint
CREATE TABLE `merchants` (
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
	`active_task_id` text,
	`lease_token` text,
	`lease_until` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`author_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "merchants_simulation_only" CHECK("merchants"."mode" = 'simulation')
);
--> statement-breakpoint
CREATE UNIQUE INDEX `merchants_client_unique` ON `merchants` (`client_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `merchants_author_request_unique` ON `merchants` (`author_id`,`request_id`);--> statement-breakpoint
CREATE INDEX `merchants_author_created_idx` ON `merchants` (`author_id`,`created_at`,`id`);--> statement-breakpoint
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
CREATE INDEX `payment_attempts_task_time_idx` ON `payment_attempts` (`task_id`,`started_at`);--> statement-breakpoint
CREATE TABLE `payment_outbox` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`delivered_at` integer,
	FOREIGN KEY (`task_id`) REFERENCES `payment_tasks`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `payment_outbox_task_unique` ON `payment_outbox` (`task_id`);--> statement-breakpoint
CREATE INDEX `payment_outbox_delivery_idx` ON `payment_outbox` (`delivered_at`,`created_at`);--> statement-breakpoint
CREATE TABLE `payment_tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`claim_id` text NOT NULL,
	`merchant_id` text NOT NULL,
	`client_id` text NOT NULL,
	`business_no` text NOT NULL,
	`recipient_id` text NOT NULL,
	`amount_minor` integer NOT NULL,
	`mode` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`reason` text,
	`external_order_id` text,
	`attempt_count` integer DEFAULT 0 NOT NULL,
	`reconciliation_count` integer DEFAULT 0 NOT NULL,
	`next_run_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`confirmed_at` integer,
	FOREIGN KEY (`claim_id`) REFERENCES `claims`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`merchant_id`) REFERENCES `merchants`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "payment_tasks_simulation_only" CHECK("payment_tasks"."mode" = 'simulation'),
	CONSTRAINT "payment_tasks_amount_positive" CHECK("payment_tasks"."amount_minor" > 0 AND "payment_tasks"."amount_minor" <= 9007199254740991)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `payment_tasks_claim_unique` ON `payment_tasks` (`claim_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `payment_tasks_business_unique` ON `payment_tasks` (`client_id`,`business_no`);--> statement-breakpoint
CREATE INDEX `payment_tasks_due_idx` ON `payment_tasks` (`status`,`next_run_at`);--> statement-breakpoint
CREATE INDEX `payment_tasks_merchant_time_idx` ON `payment_tasks` (`merchant_id`,`created_at`,`id`);--> statement-breakpoint
CREATE TABLE `simulation_controls` (
	`merchant_id` text PRIMARY KEY NOT NULL,
	`scenario` text DEFAULT 'normal' NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`merchant_id`) REFERENCES `merchants`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `simulation_orders` (
	`id` text PRIMARY KEY NOT NULL,
	`client_id` text NOT NULL,
	`business_no` text NOT NULL,
	`recipient_id` text NOT NULL,
	`amount_minor` integer NOT NULL,
	`visible_at` integer NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `simulation_orders_business_unique` ON `simulation_orders` (`client_id`,`business_no`);