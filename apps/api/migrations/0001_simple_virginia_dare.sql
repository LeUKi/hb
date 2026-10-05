CREATE TABLE `activities` (
	`id` text PRIMARY KEY NOT NULL,
	`author_id` text NOT NULL,
	`creation_request_id` text NOT NULL,
	`creation_digest` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`title` text NOT NULL,
	`reward_type` text DEFAULT 'text' NOT NULL,
	`force_dedicated` integer NOT NULL,
	`topic_id` text,
	`allocation` text NOT NULL,
	`config` text NOT NULL,
	`total_count` integer NOT NULL,
	`claimed_count` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`opened_at` integer,
	`deadline` integer,
	`ended_at` integer,
	FOREIGN KEY (`author_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `activities_author_request_unique` ON `activities` (`author_id`,`creation_request_id`);--> statement-breakpoint
CREATE INDEX `activities_author_created_idx` ON `activities` (`author_id`,`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `activities_deadline_idx` ON `activities` (`deadline`);--> statement-breakpoint
CREATE INDEX `activities_topic_idx` ON `activities` (`topic_id`);--> statement-breakpoint
CREATE TABLE `activity_passwords` (
	`id` text PRIMARY KEY NOT NULL,
	`activity_id` text NOT NULL,
	`digest` text NOT NULL,
	`ciphertext` text NOT NULL,
	`position` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`activity_id`) REFERENCES `activities`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `activity_passwords_activity_digest_unique` ON `activity_passwords` (`activity_id`,`digest`);--> statement-breakpoint
CREATE INDEX `activity_passwords_digest_idx` ON `activity_passwords` (`digest`);--> statement-breakpoint
CREATE TABLE `text_inventory` (
	`id` text NOT NULL,
	`activity_id` text NOT NULL,
	`position` integer NOT NULL,
	`ciphertext` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`activity_id`, `id`),
	FOREIGN KEY (`activity_id`) REFERENCES `activities`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `text_inventory_activity_position_unique` ON `text_inventory` (`activity_id`,`position`);