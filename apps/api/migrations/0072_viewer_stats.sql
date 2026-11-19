-- 在看人数 (docs/viewer-stats-design.md): each 红包's most viewers at once,
-- how many different people looked, and its curve, as its ActivityDO last
-- wrote them. New table only.
CREATE TABLE `activity_viewer_stats` (
	`activity_id` text PRIMARY KEY NOT NULL,
	`peak` integer NOT NULL,
	`peak_at` integer NOT NULL,
	`total` integer NOT NULL,
	`curve` text,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`activity_id`) REFERENCES `activities`(`id`) ON UPDATE no action ON DELETE no action
);
