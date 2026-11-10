-- Finding someone by name (the 社区小程序's pictures, 转账, 邀请, 领取范围)
-- read every user: with provider='linux_do' in each lookup, SQLite took
-- (provider, external_id) for provider=? alone over the name's own index
-- (2026-11-10: six of every ten rows the production database read). The
-- name leads now, as written and in lower case.
DROP INDEX `users_username_idx`;--> statement-breakpoint
CREATE INDEX `users_lower_username_idx` ON `users` (lower("username"),`provider`);--> statement-breakpoint
CREATE INDEX `users_username_idx` ON `users` (`username`,`provider`);
