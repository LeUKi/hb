-- 过时 and 公告 (docs/judge-square-design.md §20): a 判定器's author tells
-- those who send 红包 with it, without deploying. New columns only.
ALTER TABLE `judges` ADD `notice` text;--> statement-breakpoint
ALTER TABLE `judges` ADD `notice_at` integer;--> statement-breakpoint
ALTER TABLE `judges` ADD `outdated_at` integer;