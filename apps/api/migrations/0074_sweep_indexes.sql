-- Indexes for two sweeps that read whole tables every five minutes (sweep
-- 2026-11-21). Indexes only; no data changes.
-- B8: the lifecycle sweep (apps/api/src/activities/lifecycle.ts) takes its
-- candidates from the 红包 running now and those ended but not yet archived,
-- not from every 红包 ever sent.
-- B5: 三方积分's sweep (docs/third-party-points-design.md §13) finds leases
-- that outlived their run and 找不到收款人 past their resend time by status.
CREATE INDEX `activities_running_idx` ON `activities` (`id`) WHERE "activities"."reward_type" = 'ldc' AND "activities"."deleted_at" IS NULL AND "activities"."opened_at" IS NOT NULL AND "activities"."ended_at" IS NULL;--> statement-breakpoint
CREATE INDEX `activities_unarchived_idx` ON `activities` (`ended_at`) WHERE "activities"."reward_type" = 'ldc' AND "activities"."deleted_at" IS NULL AND "activities"."opened_at" IS NOT NULL AND "activities"."ended_at" IS NOT NULL AND "activities"."archived_at" IS NULL;--> statement-breakpoint
CREATE INDEX `points_payments_status_lease_idx` ON `points_payments` (`status`,`lease_until`);
