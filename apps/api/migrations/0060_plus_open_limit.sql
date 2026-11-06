-- 🐟额 PLUS opens more 代码判定红包 a day (docs/programmable-hongbao-design.md
-- §1, 2026-11-07, the user): 30 for PLUS and the 站长, everyone else's
-- number as it is; noted as a change, as one in 网站管理 is.
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_judge_settings` (
	`id` text PRIMARY KEY NOT NULL,
	`version` integer NOT NULL,
	`enabled` integer DEFAULT false NOT NULL,
	`daily_open_limit` integer DEFAULT 3 NOT NULL,
	`daily_open_limit_plus` integer DEFAULT 30 NOT NULL,
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
        AND typeof("__new_judge_settings"."daily_open_limit_plus") = 'integer' AND "__new_judge_settings"."daily_open_limit_plus" BETWEEN 1 AND 1000
        AND typeof("__new_judge_settings"."daily_deploy_limit") = 'integer' AND "__new_judge_settings"."daily_deploy_limit" BETWEEN 1 AND 1000
        AND typeof("__new_judge_settings"."daily_deploy_limit_plus") = 'integer' AND "__new_judge_settings"."daily_deploy_limit_plus" BETWEEN 1 AND 1000
        AND typeof("__new_judge_settings"."monthly_limit") = 'integer' AND "__new_judge_settings"."monthly_limit" BETWEEN 1 AND 1000000)
);
--> statement-breakpoint
INSERT INTO `judge_setting_changes` (id,actor_user_id,previous_version,next_version,previous,next,created_at)
SELECT lower(hex(randomblob(16))), COALESCE((SELECT author_id FROM merchants WHERE kind='platform' AND usage_status='current' LIMIT 1), updated_by_user_id, 'migration'), version, version+1,
  json_object('enabled',json(CASE WHEN enabled=1 THEN 'true' ELSE 'false' END),'dailyOpenLimit',daily_open_limit,'dailyDeployLimit',daily_deploy_limit,'dailyDeployLimitPlus',daily_deploy_limit_plus,'monthlyLimit',monthly_limit,'networkEnabled',json(CASE WHEN network_enabled=1 THEN 'true' ELSE 'false' END)),
  json_object('enabled',json(CASE WHEN enabled=1 THEN 'true' ELSE 'false' END),'dailyOpenLimit',daily_open_limit,'dailyOpenLimitPlus',30,'dailyDeployLimit',daily_deploy_limit,'dailyDeployLimitPlus',daily_deploy_limit_plus,'monthlyLimit',monthly_limit,'networkEnabled',json(CASE WHEN network_enabled=1 THEN 'true' ELSE 'false' END)),
  CAST((julianday('now')-2440587.5)*86400000 AS INTEGER)
FROM `judge_settings` WHERE id='global';--> statement-breakpoint
INSERT INTO `__new_judge_settings`("id", "version", "enabled", "daily_open_limit", "daily_open_limit_plus", "daily_deploy_limit", "daily_deploy_limit_plus", "monthly_limit", "network_enabled", "updated_at", "updated_by_user_id") SELECT "id", "version" + 1, "enabled", "daily_open_limit", 30, "daily_deploy_limit", "daily_deploy_limit_plus", "monthly_limit", "network_enabled", CAST((julianday('now')-2440587.5)*86400000 AS INTEGER), COALESCE((SELECT author_id FROM merchants WHERE kind='platform' AND usage_status='current' LIMIT 1), updated_by_user_id, 'migration') FROM `judge_settings`;--> statement-breakpoint
DROP TABLE `judge_settings`;--> statement-breakpoint
ALTER TABLE `__new_judge_settings` RENAME TO `judge_settings`;--> statement-breakpoint
PRAGMA foreign_keys=ON;