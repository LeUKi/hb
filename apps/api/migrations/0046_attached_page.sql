-- 附带网页 (docs/attached-page-design.md, 2026-10-26): its switch, off
-- until the 站长 turns it on, and the 站长's 停用 of one 红包's page (when,
-- by whom; never undone). The address itself lives in the config.
ALTER TABLE `activities` ADD `page_stopped_at` integer;--> statement-breakpoint
ALTER TABLE `activities` ADD `page_stopped_by_user_id` text REFERENCES users(id);--> statement-breakpoint
ALTER TABLE `balance_settings` ADD `page_enabled` integer DEFAULT false NOT NULL;