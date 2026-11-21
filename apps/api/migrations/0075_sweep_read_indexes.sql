-- Indexes for reads that sorted a whole history to show a page (sweep
-- 2026-11-21, round 3). Indexes only; no data changes, and every query
-- returns the same rows as before.
-- Q1: an open 限时开奖's five faces and its 报名名单, newest or oldest first,
-- on every read and live push (apps/api/src/activities/roster-preview.ts,
-- registration-queries.ts).
-- Q2: 我的记录 on a 代码判定红包, a page of one's own judgments and of
-- others' moves on one (apps/api/src/judge/mine.ts).
-- Q4: 🐟额 明细's 红包 lines: shares received, and 发红包/退回 read from the
-- account's own 🐟额红包 locks (apps/api/src/balance/ledger.ts).
CREATE INDEX `activity_registrations_activity_time_idx` ON `activity_registrations` (`activity_id`,`registered_at`,`id`);--> statement-breakpoint
CREATE INDEX `balance_entries_hongbao_idx` ON `balance_entries` (`user_id`,`created_at`,`id`) WHERE "balance_entries"."kind" = 'hongbao';--> statement-breakpoint
CREATE INDEX `balance_locks_activity_user_idx` ON `balance_locks` (`user_id`) WHERE "balance_locks"."purpose" = 'activity';--> statement-breakpoint
CREATE INDEX `code_judgment_moves_others_idx` ON `code_judgment_moves` (`activity_id`,`user_id`,`created_at`,`position`,`submission_row_id`) WHERE "code_judgment_moves"."position" > 0;--> statement-breakpoint
CREATE INDEX `code_judgments_user_time_idx` ON `code_judgments` (`activity_id`,`user_id`,`judged_at`,`submission_row_id`);
