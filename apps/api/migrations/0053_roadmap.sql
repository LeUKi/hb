CREATE TABLE `roadmap_changes` (
	`id` text PRIMARY KEY NOT NULL,
	`actor_user_id` text NOT NULL,
	`item_id` text NOT NULL,
	`action` text NOT NULL,
	`title` text NOT NULL,
	`reason` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`actor_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`item_id`) REFERENCES `roadmap_items`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `roadmap_changes_time_idx` ON `roadmap_changes` (`created_at`);--> statement-breakpoint
CREATE TABLE `roadmap_items` (
	`id` text PRIMARY KEY NOT NULL,
	`status` text NOT NULL,
	`title` text NOT NULL,
	`detail` text DEFAULT '' NOT NULL,
	`author_id` text NOT NULL,
	`reason` text,
	`merged_into` text,
	`hidden` integer DEFAULT false NOT NULL,
	`votes` integer DEFAULT 0 NOT NULL,
	`started_at` integer,
	`done_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`author_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`merged_into`) REFERENCES `roadmap_items`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "roadmap_items_shape" CHECK(length("roadmap_items"."title") BETWEEN 1 AND 40 AND "roadmap_items"."title" = trim("roadmap_items"."title")
        AND length("roadmap_items"."detail") <= 500 AND typeof("roadmap_items"."votes") = 'integer' AND "roadmap_items"."votes" >= 0
        AND ("roadmap_items"."reason" IS NULL OR length("roadmap_items"."reason") BETWEEN 1 AND 100)
        AND (("roadmap_items"."status" = 'merged') = ("roadmap_items"."merged_into" IS NOT NULL)))
);
--> statement-breakpoint
CREATE INDEX `roadmap_items_hot_idx` ON `roadmap_items` (`status`,`votes`,`created_at`);--> statement-breakpoint
CREATE INDEX `roadmap_items_new_idx` ON `roadmap_items` (`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `roadmap_items_done_idx` ON `roadmap_items` (`status`,`done_at`);--> statement-breakpoint
CREATE TABLE `roadmap_notes` (
	`id` text PRIMARY KEY NOT NULL,
	`item_id` text NOT NULL,
	`text` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`item_id`) REFERENCES `roadmap_items`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "roadmap_notes_shape" CHECK(length("roadmap_notes"."text") BETWEEN 1 AND 100)
);
--> statement-breakpoint
CREATE INDEX `roadmap_notes_item_idx` ON `roadmap_notes` (`item_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `roadmap_votes` (
	`item_id` text NOT NULL,
	`user_id` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`item_id`, `user_id`),
	FOREIGN KEY (`item_id`) REFERENCES `roadmap_items`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
