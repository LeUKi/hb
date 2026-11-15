-- 私信通知's pace (docs/notification-design.md §2.3), set in 网站管理: any
-- two mails 3 s apart, two to one person 20 s (Stage 2026-11-15: the 社区
-- turned only the first of a burst into a private message). A new table
-- with its one row; no data changes.
CREATE TABLE `notice_settings` (
	`id` text PRIMARY KEY NOT NULL,
	`any_gap_seconds` integer NOT NULL,
	`same_person_gap_seconds` integer NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`updated_by` text,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`updated_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "notice_settings_singleton" CHECK("notice_settings"."id" = 'global')
);
--> statement-breakpoint
INSERT INTO `notice_settings` (`id`,`any_gap_seconds`,`same_person_gap_seconds`,`version`,`updated_at`) VALUES ('global',3,20,1,CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER));
