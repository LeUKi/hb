-- 社区小程序's 中转 (docs/mini-app-design.md §8): where the mini app asked
-- /magic to lead, one row per LINUX DO id. A new table; no data changes.
CREATE TABLE `mini_hops` (
	`linux_do_id` text PRIMARY KEY NOT NULL,
	`target` text NOT NULL,
	`created_at` integer NOT NULL
);
