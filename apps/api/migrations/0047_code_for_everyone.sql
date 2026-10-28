-- 代码判定红包 for everyone, and from 商户 too (docs/programmable-hongbao-design.md
-- §1, §2, §5, 2026-10-28): 部署 2 a day, 10 for 🐟额 PLUS and the 站长; its
-- rules no longer say 🐟额 only; and a share's range counts what is left
-- as the 红包's total less the shares made, where no 🐟额 is locked.
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_judge_settings` (
	`id` text PRIMARY KEY NOT NULL,
	`version` integer NOT NULL,
	`enabled` integer DEFAULT false NOT NULL,
	`daily_open_limit` integer DEFAULT 3 NOT NULL,
	`daily_deploy_limit` integer DEFAULT 2 NOT NULL,
	`daily_deploy_limit_plus` integer DEFAULT 10 NOT NULL,
	`monthly_limit` integer DEFAULT 1000 NOT NULL,
	`network_enabled` integer DEFAULT false NOT NULL,
	`updated_at` integer NOT NULL,
	`updated_by_user_id` text,
	CONSTRAINT "judge_settings_singleton" CHECK("__new_judge_settings"."id" = 'global'),
	CONSTRAINT "judge_settings_valid" CHECK(typeof("__new_judge_settings"."version") = 'integer' AND "__new_judge_settings"."version" >= 1
        AND "__new_judge_settings"."enabled" IN (0, 1) AND "__new_judge_settings"."network_enabled" IN (0, 1)
        AND typeof("__new_judge_settings"."daily_open_limit") = 'integer' AND "__new_judge_settings"."daily_open_limit" BETWEEN 1 AND 1000
        AND typeof("__new_judge_settings"."daily_deploy_limit") = 'integer' AND "__new_judge_settings"."daily_deploy_limit" BETWEEN 1 AND 1000
        AND typeof("__new_judge_settings"."daily_deploy_limit_plus") = 'integer' AND "__new_judge_settings"."daily_deploy_limit_plus" BETWEEN 1 AND 1000
        AND typeof("__new_judge_settings"."monthly_limit") = 'integer' AND "__new_judge_settings"."monthly_limit" BETWEEN 1 AND 1000000)
);
--> statement-breakpoint
-- The change, written as the 站长's, as a change in 网站管理 is.
INSERT INTO `judge_setting_changes` (id,actor_user_id,previous_version,next_version,previous,next,created_at)
SELECT lower(hex(randomblob(16))), COALESCE((SELECT author_id FROM merchants WHERE kind='platform' AND usage_status='current' LIMIT 1), updated_by_user_id, 'migration'), version, version+1,
  json_object('enabled',json(CASE WHEN enabled=1 THEN 'true' ELSE 'false' END),'dailyOpenLimit',daily_open_limit,'dailyDeployLimit',daily_deploy_limit,'monthlyLimit',monthly_limit,'networkEnabled',json(CASE WHEN network_enabled=1 THEN 'true' ELSE 'false' END)),
  json_object('enabled',json(CASE WHEN enabled=1 THEN 'true' ELSE 'false' END),'dailyOpenLimit',daily_open_limit,'dailyDeployLimit',2,'dailyDeployLimitPlus',daily_deploy_limit,'monthlyLimit',monthly_limit,'networkEnabled',json(CASE WHEN network_enabled=1 THEN 'true' ELSE 'false' END)),
  CAST((julianday('now')-2440587.5)*86400000 AS INTEGER)
FROM `judge_settings` WHERE id='global';--> statement-breakpoint
-- The old one number is PLUS's now; everyone else deploys 2 a day.
INSERT INTO `__new_judge_settings`("id", "version", "enabled", "daily_open_limit", "daily_deploy_limit", "daily_deploy_limit_plus", "monthly_limit", "network_enabled", "updated_at", "updated_by_user_id") SELECT "id", "version" + 1, "enabled", "daily_open_limit", 2, "daily_deploy_limit", "monthly_limit", "network_enabled", CAST((julianday('now')-2440587.5)*86400000 AS INTEGER), COALESCE((SELECT author_id FROM merchants WHERE kind='platform' AND usage_status='current' LIMIT 1), updated_by_user_id, 'migration') FROM `judge_settings`;--> statement-breakpoint
DROP TABLE `judge_settings`;--> statement-breakpoint
ALTER TABLE `__new_judge_settings` RENAME TO `judge_settings`;--> statement-breakpoint
PRAGMA foreign_keys=ON;
--> statement-breakpoint
DROP TRIGGER activities_participation_insert_guard;
--> statement-breakpoint
CREATE TRIGGER activities_participation_insert_guard BEFORE INSERT ON activities
WHEN NEW.participation_mode NOT IN ('password','direct','code')
 OR (NEW.deleted_at IS NULL AND COALESCE(json_extract(NEW.config,'$.participationMode'),'password') IS NOT NEW.participation_mode)
 OR (NEW.participation_mode='direct' AND NEW.force_dedicated!=0)
 OR (NEW.deleted_at IS NULL AND (NEW.participation_mode='code') != (COALESCE(json_extract(NEW.config,'$.money.mode'),'')='code'))
 OR (NEW.participation_mode='code' AND (NEW.force_dedicated!=1 OR NEW.join_square!=1
   OR NEW.allocation!='sequential' OR NEW.draw_state IS NOT NULL))
BEGIN SELECT RAISE(ABORT,'invalid_participation_mode'); END;
--> statement-breakpoint
DROP TRIGGER activities_participation_update_guard;
--> statement-breakpoint
CREATE TRIGGER activities_participation_update_guard BEFORE UPDATE ON activities
WHEN NEW.participation_mode NOT IN ('password','direct','code')
 OR (OLD.opened_at IS NOT NULL AND NEW.participation_mode IS NOT OLD.participation_mode)
 OR (NEW.deleted_at IS NULL AND COALESCE(json_extract(NEW.config,'$.participationMode'),'password') IS NOT NEW.participation_mode)
 OR (NEW.participation_mode='direct' AND NEW.force_dedicated!=0)
 OR (NEW.deleted_at IS NULL AND (NEW.participation_mode='code') != (COALESCE(json_extract(NEW.config,'$.money.mode'),'')='code'))
 OR (NEW.participation_mode='code' AND (NEW.force_dedicated!=1 OR NEW.join_square!=1
   OR NEW.allocation!='sequential' OR NEW.draw_state IS NOT NULL))
BEGIN SELECT RAISE(ABORT,'invalid_participation_mode'); END;
--> statement-breakpoint
-- Each share at its claim, next in line, within its range (第 2 节): what
-- is left is the 🐟额 still locked, or for 商户直发 the total less the
-- shares made.
DROP TRIGGER reward_inventory_code_insert_guard;
--> statement-breakpoint
CREATE TRIGGER reward_inventory_code_insert_guard BEFORE INSERT ON reward_inventory
WHEN EXISTS(SELECT 1 FROM activities WHERE id=NEW.activity_id AND participation_mode='code')
 AND NOT EXISTS(SELECT 1 FROM (
     SELECT a.claimed_count AS claimed, a.total_count AS total, c.min_each_minor AS min_each,
       CASE WHEN a.funding='balance'
         THEN (SELECT l.remaining_minor FROM balance_locks l WHERE l.activity_id=a.id AND l.purpose='activity' AND l.status='active')
         ELSE CAST(ROUND(CAST(json_extract(a.config,'$.money.totalAmount') AS REAL)*100) AS INTEGER)
           - COALESCE((SELECT SUM(r.amount_minor) FROM reward_inventory r WHERE r.activity_id=a.id),0)
       END AS remaining
     FROM activities a JOIN activity_code c ON c.activity_id=a.id
     WHERE a.id=NEW.activity_id AND a.opened_at IS NOT NULL AND a.ended_at IS NULL AND a.deleted_at IS NULL
       AND c.stopped_at IS NULL AND a.claimed_count<a.total_count) s
   WHERE s.remaining IS NOT NULL AND NEW.kind='ldc' AND NEW.position=s.claimed
     AND ((s.claimed+1=s.total AND NEW.amount_minor=s.remaining)
       OR (s.claimed+1<s.total AND NEW.amount_minor>=s.min_each
         AND NEW.amount_minor<=s.remaining-(s.total-s.claimed-1)*s.min_each)))
BEGIN SELECT RAISE(ABORT,'invalid_code_share'); END;
