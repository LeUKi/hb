-- 论坛小程序 (docs/mini-app-design.md §7, 2026-11-02): where a claim or a
-- timed draw's sign-up was made — "mini" in the forum's mini app, null on
-- 红包站. A draw's prize is the sign-up's.
ALTER TABLE `activity_registrations` ADD `via` text;--> statement-breakpoint
ALTER TABLE `claims` ADD `via` text;