-- 三方积分's 发放记录 (docs/third-party-points-design.md §7): a system's
-- 红包 newest first, one 红包's payouts by status and latest change, and the
-- search by recipient or the issuer's number — each from its own index,
-- not a read of every row. Indexes only; no data changes.
DROP INDEX `points_payments_activity_idx`;--> statement-breakpoint
CREATE INDEX `points_payments_recipient_idx` ON `points_payments` (`system_id`,`recipient_external_id`,`updated_at`);--> statement-breakpoint
CREATE INDEX `points_payments_trade_no_idx` ON `points_payments` (`trade_no`) WHERE "points_payments"."trade_no" IS NOT NULL;--> statement-breakpoint
CREATE INDEX `points_payments_activity_idx` ON `points_payments` (`activity_id`,`status`,`updated_at`);--> statement-breakpoint
CREATE INDEX `activities_points_opened_idx` ON `activities` (`points_system_id`,"opened_at" DESC,"id" DESC) WHERE "activities"."points_system_id" IS NOT NULL AND "activities"."opened_at" IS NOT NULL;