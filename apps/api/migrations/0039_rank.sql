CREATE TABLE `rank_snapshots` (
	`board` text NOT NULL,
	`range` text NOT NULL,
	`computed_at` integer NOT NULL,
	`entries` text NOT NULL,
	PRIMARY KEY(`board`, `range`)
);
--> statement-breakpoint
ALTER TABLE `users` ADD `rank_sent_visible` integer;--> statement-breakpoint
ALTER TABLE `users` ADD `rank_received_visible` integer;