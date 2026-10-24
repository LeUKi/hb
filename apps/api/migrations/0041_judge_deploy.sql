CREATE TABLE `judge_setting_changes` (
	`id` text PRIMARY KEY NOT NULL,
	`actor_user_id` text NOT NULL,
	`previous_version` integer NOT NULL,
	`next_version` integer NOT NULL,
	`previous` text NOT NULL,
	`next` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `judge_setting_changes_version_unique` ON `judge_setting_changes` (`next_version`);--> statement-breakpoint
CREATE INDEX `judge_setting_changes_time_idx` ON `judge_setting_changes` (`created_at`,`id`);--> statement-breakpoint
CREATE TABLE `judge_settings` (
	`id` text PRIMARY KEY NOT NULL,
	`version` integer NOT NULL,
	`enabled` integer DEFAULT false NOT NULL,
	`daily_open_limit` integer DEFAULT 3 NOT NULL,
	`daily_deploy_limit` integer DEFAULT 10 NOT NULL,
	`monthly_limit` integer DEFAULT 1000 NOT NULL,
	`updated_at` integer NOT NULL,
	`updated_by_user_id` text,
	CONSTRAINT "judge_settings_singleton" CHECK("judge_settings"."id" = 'global'),
	CONSTRAINT "judge_settings_valid" CHECK(typeof("judge_settings"."version") = 'integer' AND "judge_settings"."version" >= 1
        AND "judge_settings"."enabled" IN (0, 1)
        AND typeof("judge_settings"."daily_open_limit") = 'integer' AND "judge_settings"."daily_open_limit" BETWEEN 1 AND 1000
        AND typeof("judge_settings"."daily_deploy_limit") = 'integer' AND "judge_settings"."daily_deploy_limit" BETWEEN 1 AND 1000
        AND typeof("judge_settings"."monthly_limit") = 'integer' AND "judge_settings"."monthly_limit" BETWEEN 1 AND 1000000)
);
--> statement-breakpoint
CREATE TABLE `judge_usage` (
	`day` text NOT NULL,
	`sandbox_id` text NOT NULL,
	`fingerprint` text NOT NULL,
	`fresh` integer NOT NULL,
	`user_id` text NOT NULL,
	`activity_id` text,
	`deploys` integer DEFAULT 0 NOT NULL,
	`reruns` integer DEFAULT 0 NOT NULL,
	`claims` integer DEFAULT 0 NOT NULL,
	`timeouts` integer DEFAULT 0 NOT NULL,
	`switches` integer DEFAULT 0 NOT NULL,
	`first_at` integer NOT NULL,
	`last_at` integer NOT NULL,
	PRIMARY KEY(`day`, `sandbox_id`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`activity_id`) REFERENCES `activities`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "judge_usage_shape" CHECK(length("judge_usage"."fingerprint") = 64
        AND typeof("judge_usage"."fresh") = 'integer' AND "judge_usage"."fresh" BETWEEN 0 AND 3
        AND "judge_usage"."sandbox_id" = 'judge:v1:' || "judge_usage"."fingerprint" || CASE WHEN "judge_usage"."fresh" > 0 THEN ':' || "judge_usage"."fresh" ELSE '' END
        AND typeof("judge_usage"."first_at") = 'integer' AND typeof("judge_usage"."last_at") = 'integer' AND "judge_usage"."first_at" <= "judge_usage"."last_at"
        AND "judge_usage"."day" = strftime('%Y-%m-%d', "judge_usage"."first_at" / 1000, 'unixepoch')
        AND typeof("judge_usage"."deploys") = 'integer' AND "judge_usage"."deploys" >= 0
        AND typeof("judge_usage"."reruns") = 'integer' AND "judge_usage"."reruns" >= 0
        AND typeof("judge_usage"."claims") = 'integer' AND "judge_usage"."claims" >= 0
        AND typeof("judge_usage"."timeouts") = 'integer' AND "judge_usage"."timeouts" >= 0
        AND typeof("judge_usage"."switches") = 'integer' AND "judge_usage"."switches" BETWEEN 0 AND "judge_usage"."timeouts")
);
--> statement-breakpoint
CREATE TABLE `judge_run_leases` (
	`user_id` text PRIMARY KEY NOT NULL,
	`token` text NOT NULL,
	`lease_until` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "judge_run_leases_valid" CHECK(length("judge_run_leases"."token") = 36 AND typeof("judge_run_leases"."lease_until") = 'integer')
);
--> statement-breakpoint
ALTER TABLE `activity_code` ADD `versions_ciphertext` text;--> statement-breakpoint
ALTER TABLE `judge_checks` ADD `kind` text DEFAULT 'deploy' NOT NULL;--> statement-breakpoint
ALTER TABLE `judge_checks` ADD `finished_at` integer;--> statement-breakpoint
CREATE INDEX `judge_checks_kind_time_idx` ON `judge_checks` (`kind`,`created_at`);--> statement-breakpoint
-- 判定器设置 leave 🐟额's row for their own (redesign/07 §10), as they
-- were: 在线检查's daily count becomes the daily count of deploys.
INSERT INTO judge_settings (id, version, enabled, daily_open_limit, daily_deploy_limit, monthly_limit, updated_at)
SELECT 'global', 1, COALESCE(b.code_hongbao_enabled, 0), COALESCE(b.code_hongbao_daily_limit, 3),
  COALESCE(b.code_check_daily_limit, 10), 1000, CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)
FROM (SELECT 1) LEFT JOIN balance_settings b ON b.id = 'global';
--> statement-breakpoint
-- A column named in a trigger cannot be dropped.
DROP TRIGGER balance_settings_code_limits_valid;
--> statement-breakpoint
ALTER TABLE `balance_settings` DROP COLUMN `code_hongbao_enabled`;--> statement-breakpoint
ALTER TABLE `balance_settings` DROP COLUMN `code_hongbao_daily_limit`;--> statement-breakpoint
ALTER TABLE `balance_settings` DROP COLUMN `code_check_daily_limit`;
--> statement-breakpoint
CREATE TRIGGER judge_setting_changes_immutable BEFORE UPDATE ON judge_setting_changes
BEGIN SELECT RAISE(ABORT,'judge setting changes are append-only'); END;
--> statement-breakpoint
CREATE TRIGGER judge_setting_changes_no_delete BEFORE DELETE ON judge_setting_changes
BEGIN SELECT RAISE(ABORT,'judge setting changes are append-only'); END;
--> statement-breakpoint
-- 部署 (docs/programmable-hongbao-design.md §5): a sender's first run of a
-- code deploys it, every later run reruns its tests. A run is written as
-- it starts, so one cut off still counts, and once more as it finishes,
-- with whether it passed; nothing else ever changes. The runs so far read
-- the same way, in order, all finished.
DROP TRIGGER judge_checks_immutable;
--> statement-breakpoint
UPDATE judge_checks SET kind = 'rerun' WHERE EXISTS(SELECT 1 FROM judge_checks e
  WHERE e.user_id = judge_checks.user_id AND e.protocol = judge_checks.protocol AND e.fingerprint = judge_checks.fingerprint
    AND (e.created_at < judge_checks.created_at OR (e.created_at = judge_checks.created_at AND e.id < judge_checks.id)));
--> statement-breakpoint
UPDATE judge_checks SET finished_at = created_at;
--> statement-breakpoint
CREATE TRIGGER judge_checks_immutable BEFORE UPDATE ON judge_checks
WHEN OLD.finished_at IS NOT NULL OR NEW.finished_at IS NULL OR typeof(NEW.finished_at)!='integer'
 OR NEW.finished_at<OLD.created_at OR NEW.passed NOT IN (0,1)
 OR NEW.id IS NOT OLD.id OR NEW.user_id IS NOT OLD.user_id OR NEW.protocol IS NOT OLD.protocol
 OR NEW.fingerprint IS NOT OLD.fingerprint OR NEW.tests_digest IS NOT OLD.tests_digest
 OR NEW.kind IS NOT OLD.kind OR NEW.created_at IS NOT OLD.created_at
BEGIN SELECT RAISE(ABORT,'immutable_judge_check'); END;
--> statement-breakpoint
DROP TRIGGER judge_checks_insert_guard;
--> statement-breakpoint
CREATE TRIGGER judge_checks_insert_guard BEFORE INSERT ON judge_checks
WHEN NEW.protocol!=1 OR length(NEW.fingerprint)!=64 OR length(NEW.tests_digest)!=64 OR NEW.passed NOT IN (0,1)
 OR (NEW.passed=1 AND NEW.finished_at IS NULL)
 OR (NEW.finished_at IS NOT NULL AND (typeof(NEW.finished_at)!='integer' OR NEW.finished_at<NEW.created_at))
 OR NEW.kind IS NOT (CASE WHEN EXISTS(SELECT 1 FROM judge_checks WHERE user_id=NEW.user_id AND protocol=NEW.protocol
   AND fingerprint=NEW.fingerprint) THEN 'rerun' ELSE 'deploy' END)
BEGIN SELECT RAISE(ABORT,'invalid_judge_check'); END;
--> statement-breakpoint
-- A draft's deployed versions (§5 版本, 换回) change with its code, and from
-- opening stay as they were, like it.
DROP TRIGGER activity_code_update_guard;
--> statement-breakpoint
CREATE TRIGGER activity_code_update_guard BEFORE UPDATE ON activity_code
WHEN NEW.activity_id IS NOT OLD.activity_id OR NEW.created_at IS NOT OLD.created_at
 OR (OLD.seed_commitment IS NOT NULL AND (NEW.seed_commitment IS NOT OLD.seed_commitment
   OR NEW.seed_ciphertext IS NOT OLD.seed_ciphertext))
 OR (EXISTS(SELECT 1 FROM activities WHERE id=OLD.activity_id AND opened_at IS NOT NULL) AND (
   NEW.protocol IS NOT OLD.protocol OR NEW.prompt IS NOT OLD.prompt OR NEW.fingerprint IS NOT OLD.fingerprint
   OR NEW.code_ciphertext IS NOT OLD.code_ciphertext OR NEW.tests_ciphertext IS NOT OLD.tests_ciphertext
   OR NEW.tests_digest IS NOT OLD.tests_digest OR NEW.min_each_minor IS NOT OLD.min_each_minor
   OR NEW.versions_ciphertext IS NOT OLD.versions_ciphertext))
 OR (NOT EXISTS(SELECT 1 FROM activities WHERE id=OLD.activity_id AND opened_at IS NOT NULL) AND (
   NEW.state_ciphertext IS NOT NULL OR NEW.failures_in_row!=0 OR NEW.sandbox!=0 OR NEW.paused_at IS NOT NULL
   OR NEW.stopped_at IS NOT NULL OR NEW.revealed_at IS NOT NULL))
 OR (OLD.paused_at IS NOT NULL AND NEW.paused_at IS NOT OLD.paused_at)
 OR (OLD.stopped_at IS NOT NULL AND (NEW.stopped_at IS NOT OLD.stopped_at OR NEW.stopped_by_user_id IS NOT OLD.stopped_by_user_id))
 OR (OLD.revealed_at IS NOT NULL AND (NEW.code IS NOT OLD.code OR NEW.seed IS NOT OLD.seed OR NEW.revealed_at IS NOT OLD.revealed_at))
 OR (OLD.revealed_at IS NULL AND NEW.revealed_at IS NOT NULL AND NOT EXISTS(SELECT 1 FROM activities a
   WHERE a.id=OLD.activity_id AND a.opened_at IS NOT NULL AND (a.ended_at IS NOT NULL OR a.claimed_count>=a.total_count
     OR a.deadline<=CAST((julianday('now')-2440587.5)*86400000 AS INTEGER))))
BEGIN SELECT RAISE(ABORT,'immutable_activity_code'); END;
--> statement-breakpoint
-- 用量记录 (§7): a claim's row is its 红包's, on that 红包's own code; a
-- row only adds up, takes its 红包 at most once, and goes after 90 days.
CREATE TRIGGER judge_usage_insert_guard BEFORE INSERT ON judge_usage
WHEN NEW.activity_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM activities a JOIN activity_code c ON c.activity_id=a.id
   WHERE a.id=NEW.activity_id AND a.participation_mode='code' AND a.opened_at IS NOT NULL AND c.fingerprint=NEW.fingerprint)
BEGIN SELECT RAISE(ABORT,'invalid_judge_usage'); END;
--> statement-breakpoint
CREATE TRIGGER judge_usage_update_guard BEFORE UPDATE ON judge_usage
WHEN NEW.day IS NOT OLD.day OR NEW.sandbox_id IS NOT OLD.sandbox_id OR NEW.fingerprint IS NOT OLD.fingerprint
 OR NEW.fresh IS NOT OLD.fresh OR NEW.user_id IS NOT OLD.user_id OR NEW.first_at IS NOT OLD.first_at
 OR (OLD.activity_id IS NOT NULL AND NEW.activity_id IS NOT OLD.activity_id)
 OR (OLD.activity_id IS NULL AND NEW.activity_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM activities a
   JOIN activity_code c ON c.activity_id=a.id
   WHERE a.id=NEW.activity_id AND a.participation_mode='code' AND a.opened_at IS NOT NULL AND c.fingerprint=NEW.fingerprint))
 OR NEW.deploys<OLD.deploys OR NEW.reruns<OLD.reruns OR NEW.claims<OLD.claims OR NEW.timeouts<OLD.timeouts
 OR NEW.switches<OLD.switches OR NEW.last_at<OLD.last_at
BEGIN SELECT RAISE(ABORT,'invalid_judge_usage'); END;
--> statement-breakpoint
CREATE TRIGGER judge_usage_delete_guard BEFORE DELETE ON judge_usage
WHEN OLD.day>=strftime('%Y-%m-%d','now','-90 days')
BEGIN SELECT RAISE(ABORT,'judge_usage_kept_90_days'); END;
