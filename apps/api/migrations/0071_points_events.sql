-- 三方积分 操作记录 (docs/third-party-points-design.md §17): what happened
-- to each system and who did it, and why it was paused. New table and
-- column; the history known so far is seeded — first online (by whom it was
-- reviewed), a pause in force now, 下架 — earlier steps were not kept.
CREATE TABLE `points_events` (
	`id` text PRIMARY KEY NOT NULL,
	`system_id` text NOT NULL,
	`at` integer NOT NULL,
	`actor` text NOT NULL,
	`actor_id` text,
	`action` text NOT NULL,
	`note` text,
	FOREIGN KEY (`system_id`) REFERENCES `points_systems`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`actor_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `points_events_system_time_idx` ON `points_events` (`system_id`,"at" DESC,"id" DESC);--> statement-breakpoint
ALTER TABLE `points_systems` ADD `pause_reason` text;
--> statement-breakpoint
INSERT INTO `points_events` (`id`,`system_id`,`at`,`actor`,`actor_id`,`action`,`note`)
SELECT lower(hex(randomblob(16))),`id`,`online_at`,'admin',`reviewed_by`,'approve',NULL
FROM `points_systems` WHERE `online_at` IS NOT NULL;--> statement-breakpoint
INSERT INTO `points_events` (`id`,`system_id`,`at`,`actor`,`actor_id`,`action`,`note`)
SELECT lower(hex(randomblob(16))),`id`,`paused_at`,CASE WHEN `paused_by`='admin' THEN 'admin' ELSE 'owner' END,
  CASE WHEN `paused_by`='admin' THEN NULL ELSE `owner_id` END,'pause',NULL
FROM `points_systems` WHERE `status`='paused' AND `paused_at` IS NOT NULL;--> statement-breakpoint
INSERT INTO `points_events` (`id`,`system_id`,`at`,`actor`,`actor_id`,`action`,`note`)
SELECT lower(hex(randomblob(16))),`id`,`retired_at`,CASE WHEN `paused_by`='admin' THEN 'admin' ELSE 'owner' END,
  CASE WHEN `paused_by`='admin' THEN NULL ELSE `owner_id` END,'retire',NULL
FROM `points_systems` WHERE `status`='retired' AND `retired_at` IS NOT NULL;
