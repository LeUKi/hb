PRAGMA defer_foreign_keys=ON;--> statement-breakpoint
ALTER TABLE `text_inventory` RENAME TO `reward_inventory`;--> statement-breakpoint
CREATE TABLE `__new_reward_inventory` (
	`id` text NOT NULL,
	`activity_id` text NOT NULL,
	`position` integer NOT NULL,
	`kind` text DEFAULT 'text' NOT NULL,
	`ciphertext` text,
	`amount_minor` integer,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`activity_id`, `id`),
	FOREIGN KEY (`activity_id`) REFERENCES `activities`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "reward_inventory_content" CHECK(("__new_reward_inventory"."kind" = 'text' AND "__new_reward_inventory"."ciphertext" IS NOT NULL AND "__new_reward_inventory"."amount_minor" IS NULL) OR ("__new_reward_inventory"."kind" = 'ldc' AND "__new_reward_inventory"."ciphertext" IS NULL AND "__new_reward_inventory"."amount_minor" IS NOT NULL AND typeof("__new_reward_inventory"."amount_minor") = 'integer' AND "__new_reward_inventory"."amount_minor" > 0 AND "__new_reward_inventory"."amount_minor" <= 9007199254740991))
);
--> statement-breakpoint
INSERT INTO `__new_reward_inventory`("id", "activity_id", "position", "kind", "ciphertext", "amount_minor", "created_at") SELECT "id", "activity_id", "position", 'text', "ciphertext", NULL, "created_at" FROM `reward_inventory`;--> statement-breakpoint
DROP TABLE `reward_inventory`;--> statement-breakpoint
ALTER TABLE `__new_reward_inventory` RENAME TO `reward_inventory`;--> statement-breakpoint
CREATE UNIQUE INDEX `text_inventory_activity_position_unique` ON `reward_inventory` (`activity_id`,`position`);--> statement-breakpoint
CREATE TABLE `__new_claims` (
	`id` text PRIMARY KEY NOT NULL,
	`activity_id` text NOT NULL,
	`user_id` text NOT NULL,
	`inventory_id` text NOT NULL,
	`password_id` text NOT NULL,
	`claimed_at` integer NOT NULL,
	FOREIGN KEY (`activity_id`) REFERENCES `activities`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`password_id`) REFERENCES `activity_passwords`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`activity_id`,`inventory_id`) REFERENCES `reward_inventory`(`activity_id`,`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_claims`("id", "activity_id", "user_id", "inventory_id", "password_id", "claimed_at") SELECT "id", "activity_id", "user_id", "inventory_id", "password_id", "claimed_at" FROM `claims`;--> statement-breakpoint
DROP TABLE `claims`;--> statement-breakpoint
ALTER TABLE `__new_claims` RENAME TO `claims`;--> statement-breakpoint
CREATE UNIQUE INDEX `claims_activity_user_unique` ON `claims` (`activity_id`,`user_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `claims_activity_inventory_unique` ON `claims` (`activity_id`,`inventory_id`);--> statement-breakpoint
CREATE INDEX `claims_user_time_idx` ON `claims` (`user_id`,`claimed_at`,`id`);--> statement-breakpoint
CREATE INDEX `claims_activity_time_idx` ON `claims` (`activity_id`,`claimed_at`,`id`);--> statement-breakpoint
ALTER TABLE `activities` ADD `merchant_id` text REFERENCES merchants(id);
--> statement-breakpoint
PRAGMA defer_foreign_keys=OFF;
