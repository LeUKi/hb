-- 代码判定红包, protocol v2 with 联网 (docs/programmable-hongbao-design.md §9,
-- 2026-10-26): activity_code takes protocol 2 and the addresses it may ask,
-- a judgment keeps its requests, a run the addresses its code exports, the
-- settings a switch for 联网, and 用量 a 联网 红包's own 判定器 and its
-- requests. SQLite rebuilds the tables whose checks change; the triggers on
-- them, and those elsewhere that read activity_code, are made again as they
-- were, with 联网 where it belongs.
PRAGMA defer_foreign_keys=ON;--> statement-breakpoint
DROP TRIGGER activities_participation_open_guard;--> statement-breakpoint
DROP TRIGGER reward_inventory_code_insert_guard;--> statement-breakpoint
DROP TRIGGER code_judgments_insert_guard;--> statement-breakpoint
DROP TRIGGER judge_usage_insert_guard;--> statement-breakpoint
DROP TRIGGER judge_usage_update_guard;--> statement-breakpoint
CREATE TABLE `__new_activity_code` (
	`activity_id` text PRIMARY KEY NOT NULL,
	`protocol` integer NOT NULL,
	`prompt` text NOT NULL,
	`fingerprint` text NOT NULL,
	`code_ciphertext` text NOT NULL,
	`tests_ciphertext` text NOT NULL,
	`tests_digest` text NOT NULL,
	`min_each_minor` integer NOT NULL,
	`seed_commitment` text,
	`seed_ciphertext` text,
	`state_ciphertext` text,
	`failures_in_row` integer DEFAULT 0 NOT NULL,
	`sandbox` integer DEFAULT 0 NOT NULL,
	`paused_at` integer,
	`stopped_at` integer,
	`stopped_by_user_id` text,
	`code` text,
	`seed` text,
	`revealed_at` integer,
	`versions_ciphertext` text,
	`network` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`activity_id`) REFERENCES `activities`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`stopped_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "activity_code_shape" CHECK("__new_activity_code"."protocol" IN (1, 2) AND length("__new_activity_code"."fingerprint") = 64 AND length("__new_activity_code"."tests_digest") = 64
        AND ("__new_activity_code"."network" IS NULL OR ("__new_activity_code"."protocol" = 2 AND json_valid("__new_activity_code"."network")
          AND json_type("__new_activity_code"."network") = 'array' AND json_array_length("__new_activity_code"."network") BETWEEN 1 AND 3))
        AND length("__new_activity_code"."prompt") <= 40
        AND typeof("__new_activity_code"."min_each_minor") = 'integer' AND "__new_activity_code"."min_each_minor" > 0
        AND ("__new_activity_code"."seed_commitment" IS NULL) = ("__new_activity_code"."seed_ciphertext" IS NULL)
        AND ("__new_activity_code"."seed_commitment" IS NULL OR length("__new_activity_code"."seed_commitment") = 64)
        AND typeof("__new_activity_code"."failures_in_row") = 'integer' AND "__new_activity_code"."failures_in_row" BETWEEN 0 AND 5
        AND typeof("__new_activity_code"."sandbox") = 'integer' AND "__new_activity_code"."sandbox" BETWEEN 0 AND 3
        AND ("__new_activity_code"."stopped_at" IS NULL) = ("__new_activity_code"."stopped_by_user_id" IS NULL)
        AND ("__new_activity_code"."code" IS NULL) = ("__new_activity_code"."revealed_at" IS NULL)
        AND ("__new_activity_code"."seed" IS NULL) = ("__new_activity_code"."revealed_at" IS NULL)
        AND ("__new_activity_code"."seed" IS NULL OR length("__new_activity_code"."seed") = 64))
);
--> statement-breakpoint
INSERT INTO `__new_activity_code`("activity_id", "protocol", "prompt", "fingerprint", "code_ciphertext", "tests_ciphertext", "tests_digest", "min_each_minor", "seed_commitment", "seed_ciphertext", "state_ciphertext", "failures_in_row", "sandbox", "paused_at", "stopped_at", "stopped_by_user_id", "code", "seed", "revealed_at", "versions_ciphertext", "created_at", "updated_at") SELECT "activity_id", "protocol", "prompt", "fingerprint", "code_ciphertext", "tests_ciphertext", "tests_digest", "min_each_minor", "seed_commitment", "seed_ciphertext", "state_ciphertext", "failures_in_row", "sandbox", "paused_at", "stopped_at", "stopped_by_user_id", "code", "seed", "revealed_at", "versions_ciphertext", "created_at", "updated_at" FROM `activity_code`;--> statement-breakpoint
DROP TABLE `activity_code`;--> statement-breakpoint
ALTER TABLE `__new_activity_code` RENAME TO `activity_code`;--> statement-breakpoint
CREATE TABLE `__new_judge_settings` (
	`id` text PRIMARY KEY NOT NULL,
	`version` integer NOT NULL,
	`enabled` integer DEFAULT false NOT NULL,
	`daily_open_limit` integer DEFAULT 3 NOT NULL,
	`daily_deploy_limit` integer DEFAULT 10 NOT NULL,
	`monthly_limit` integer DEFAULT 1000 NOT NULL,
	`network_enabled` integer DEFAULT false NOT NULL,
	`updated_at` integer NOT NULL,
	`updated_by_user_id` text,
	CONSTRAINT "judge_settings_singleton" CHECK("__new_judge_settings"."id" = 'global'),
	CONSTRAINT "judge_settings_valid" CHECK(typeof("__new_judge_settings"."version") = 'integer' AND "__new_judge_settings"."version" >= 1
        AND "__new_judge_settings"."enabled" IN (0, 1) AND "__new_judge_settings"."network_enabled" IN (0, 1)
        AND typeof("__new_judge_settings"."daily_open_limit") = 'integer' AND "__new_judge_settings"."daily_open_limit" BETWEEN 1 AND 1000
        AND typeof("__new_judge_settings"."daily_deploy_limit") = 'integer' AND "__new_judge_settings"."daily_deploy_limit" BETWEEN 1 AND 1000
        AND typeof("__new_judge_settings"."monthly_limit") = 'integer' AND "__new_judge_settings"."monthly_limit" BETWEEN 1 AND 1000000)
);
--> statement-breakpoint
INSERT INTO `__new_judge_settings`("id", "version", "enabled", "daily_open_limit", "daily_deploy_limit", "monthly_limit", "updated_at", "updated_by_user_id") SELECT "id", "version", "enabled", "daily_open_limit", "daily_deploy_limit", "monthly_limit", "updated_at", "updated_by_user_id" FROM `judge_settings`;--> statement-breakpoint
DROP TABLE `judge_settings`;--> statement-breakpoint
ALTER TABLE `__new_judge_settings` RENAME TO `judge_settings`;--> statement-breakpoint
CREATE TABLE `__new_judge_usage` (
	`day` text NOT NULL,
	`sandbox_id` text NOT NULL,
	`protocol` integer DEFAULT 1 NOT NULL,
	`fingerprint` text NOT NULL,
	`networked` integer DEFAULT false NOT NULL,
	`fresh` integer NOT NULL,
	`user_id` text NOT NULL,
	`activity_id` text,
	`deploys` integer DEFAULT 0 NOT NULL,
	`reruns` integer DEFAULT 0 NOT NULL,
	`claims` integer DEFAULT 0 NOT NULL,
	`timeouts` integer DEFAULT 0 NOT NULL,
	`switches` integer DEFAULT 0 NOT NULL,
	`fetches` integer DEFAULT 0 NOT NULL,
	`first_at` integer NOT NULL,
	`last_at` integer NOT NULL,
	PRIMARY KEY(`day`, `sandbox_id`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`activity_id`) REFERENCES `activities`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "judge_usage_shape" CHECK(length("__new_judge_usage"."fingerprint") = 64
        AND "__new_judge_usage"."protocol" IN (1, 2) AND "__new_judge_usage"."networked" IN (0, 1)
        AND ("__new_judge_usage"."networked" = 0 OR ("__new_judge_usage"."protocol" = 2 AND "__new_judge_usage"."activity_id" IS NOT NULL))
        AND typeof("__new_judge_usage"."fresh") = 'integer' AND "__new_judge_usage"."fresh" BETWEEN 0 AND 3
        AND "__new_judge_usage"."sandbox_id" = 'judge:v' || "__new_judge_usage"."protocol" || ':' || "__new_judge_usage"."fingerprint"
          || CASE WHEN "__new_judge_usage"."networked" = 1 THEN ':' || "__new_judge_usage"."activity_id" ELSE '' END
          || CASE WHEN "__new_judge_usage"."fresh" > 0 THEN ':' || "__new_judge_usage"."fresh" ELSE '' END
        AND typeof("__new_judge_usage"."fetches") = 'integer' AND "__new_judge_usage"."fetches" >= 0
        AND typeof("__new_judge_usage"."first_at") = 'integer' AND typeof("__new_judge_usage"."last_at") = 'integer' AND "__new_judge_usage"."first_at" <= "__new_judge_usage"."last_at"
        AND "__new_judge_usage"."day" = strftime('%Y-%m-%d', "__new_judge_usage"."first_at" / 1000, 'unixepoch')
        AND typeof("__new_judge_usage"."deploys") = 'integer' AND "__new_judge_usage"."deploys" >= 0
        AND typeof("__new_judge_usage"."reruns") = 'integer' AND "__new_judge_usage"."reruns" >= 0
        AND typeof("__new_judge_usage"."claims") = 'integer' AND "__new_judge_usage"."claims" >= 0
        AND typeof("__new_judge_usage"."timeouts") = 'integer' AND "__new_judge_usage"."timeouts" >= 0
        AND typeof("__new_judge_usage"."switches") = 'integer' AND "__new_judge_usage"."switches" BETWEEN 0 AND "__new_judge_usage"."timeouts")
);
--> statement-breakpoint
INSERT INTO `__new_judge_usage`("day", "sandbox_id", "fingerprint", "fresh", "user_id", "activity_id", "deploys", "reruns", "claims", "timeouts", "switches", "first_at", "last_at") SELECT "day", "sandbox_id", "fingerprint", "fresh", "user_id", "activity_id", "deploys", "reruns", "claims", "timeouts", "switches", "first_at", "last_at" FROM `judge_usage`;--> statement-breakpoint
DROP TABLE `judge_usage`;--> statement-breakpoint
ALTER TABLE `__new_judge_usage` RENAME TO `judge_usage`;--> statement-breakpoint
ALTER TABLE `code_judgments` ADD `fetches_ciphertext` text;--> statement-breakpoint
ALTER TABLE `judge_checks` ADD `network` text;--> statement-breakpoint
CREATE TRIGGER activities_participation_open_guard BEFORE UPDATE OF opened_at ON activities
WHEN OLD.opened_at IS NULL AND NEW.opened_at IS NOT NULL AND (
 (NEW.participation_mode='password' AND NOT EXISTS(SELECT 1 FROM activity_passwords WHERE activity_id=NEW.id))
 OR (NEW.participation_mode='direct' AND EXISTS(SELECT 1 FROM activity_passwords WHERE activity_id=NEW.id))
 OR (NEW.participation_mode='code' AND (EXISTS(SELECT 1 FROM activity_passwords WHERE activity_id=NEW.id)
   OR EXISTS(SELECT 1 FROM reward_inventory WHERE activity_id=NEW.id)
   OR NOT EXISTS(SELECT 1 FROM activity_code c JOIN judge_checks k ON k.user_id=NEW.author_id
     AND k.protocol=c.protocol AND k.fingerprint=c.fingerprint AND k.tests_digest=c.tests_digest AND k.passed=1
     WHERE c.activity_id=NEW.id AND c.seed_commitment IS NOT NULL))))
BEGIN SELECT RAISE(ABORT,'invalid_participation_passwords'); END;
--> statement-breakpoint
CREATE TRIGGER reward_inventory_code_insert_guard BEFORE INSERT ON reward_inventory
WHEN EXISTS(SELECT 1 FROM activities WHERE id=NEW.activity_id AND participation_mode='code')
 AND NOT EXISTS(SELECT 1 FROM activities a JOIN activity_code c ON c.activity_id=a.id
   JOIN balance_locks l ON l.activity_id=a.id AND l.purpose='activity' AND l.status='active'
   WHERE a.id=NEW.activity_id AND a.opened_at IS NOT NULL AND a.ended_at IS NULL AND a.deleted_at IS NULL
     AND c.stopped_at IS NULL AND a.claimed_count<a.total_count AND NEW.kind='ldc' AND NEW.position=a.claimed_count
     AND ((a.claimed_count+1=a.total_count AND NEW.amount_minor=l.remaining_minor)
       OR (a.claimed_count+1<a.total_count AND NEW.amount_minor>=c.min_each_minor
         AND NEW.amount_minor<=l.remaining_minor-(a.total_count-a.claimed_count-1)*c.min_each_minor)))
BEGIN SELECT RAISE(ABORT,'invalid_code_share'); END;
--> statement-breakpoint
CREATE TRIGGER code_judgments_insert_guard BEFORE INSERT ON code_judgments
WHEN NOT EXISTS(SELECT 1 FROM redemption_submissions s JOIN activities a ON a.id=s.activity_id
   JOIN activity_code c ON c.activity_id=a.id
   WHERE s.id=NEW.submission_row_id AND s.activity_id=NEW.activity_id AND s.user_id=NEW.user_id
     AND s.participation_mode='code' AND s.purpose='claim' AND s.validated_at IS NOT NULL
     AND s.outcome=CASE WHEN NEW.ok=1 THEN 'pending' ELSE 'incorrect' END
     AND a.opened_at IS NOT NULL AND a.ended_at IS NULL AND c.paused_at IS NULL AND c.stopped_at IS NULL
     AND (NEW.fetches_ciphertext IS NULL OR c.network IS NOT NULL))
 OR NEW.attempt IS NOT (SELECT COUNT(*) FROM code_judgments WHERE activity_id=NEW.activity_id AND user_id=NEW.user_id)
 OR NEW.sequence IS NOT (SELECT COUNT(*) FROM code_judgments WHERE activity_id=NEW.activity_id)
BEGIN SELECT RAISE(ABORT,'invalid_code_judgment'); END;
--> statement-breakpoint
-- A draft has no addresses: they come from its deploy at opening, and stay.
CREATE TRIGGER activity_code_insert_guard BEFORE INSERT ON activity_code
WHEN NOT EXISTS(SELECT 1 FROM activities WHERE id=NEW.activity_id AND participation_mode='code'
   AND opened_at IS NULL AND deleted_at IS NULL)
 OR NEW.seed_commitment IS NOT NULL OR NEW.state_ciphertext IS NOT NULL OR NEW.failures_in_row!=0
 OR NEW.sandbox!=0 OR NEW.paused_at IS NOT NULL OR NEW.stopped_at IS NOT NULL OR NEW.revealed_at IS NOT NULL
 OR NEW.network IS NOT NULL
BEGIN SELECT RAISE(ABORT,'invalid_activity_code'); END;
--> statement-breakpoint
CREATE TRIGGER activity_code_update_guard BEFORE UPDATE ON activity_code
WHEN NEW.activity_id IS NOT OLD.activity_id OR NEW.created_at IS NOT OLD.created_at
 OR (OLD.seed_commitment IS NOT NULL AND (NEW.seed_commitment IS NOT OLD.seed_commitment
   OR NEW.seed_ciphertext IS NOT OLD.seed_ciphertext))
 OR (EXISTS(SELECT 1 FROM activities WHERE id=OLD.activity_id AND opened_at IS NOT NULL) AND (
   NEW.protocol IS NOT OLD.protocol OR NEW.prompt IS NOT OLD.prompt OR NEW.fingerprint IS NOT OLD.fingerprint
   OR NEW.code_ciphertext IS NOT OLD.code_ciphertext OR NEW.tests_ciphertext IS NOT OLD.tests_ciphertext
   OR NEW.tests_digest IS NOT OLD.tests_digest OR NEW.min_each_minor IS NOT OLD.min_each_minor
   OR NEW.versions_ciphertext IS NOT OLD.versions_ciphertext OR NEW.network IS NOT OLD.network))
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
CREATE TRIGGER activity_code_delete_guard BEFORE DELETE ON activity_code
WHEN EXISTS(SELECT 1 FROM activities WHERE id=OLD.activity_id AND opened_at IS NOT NULL)
BEGIN SELECT RAISE(ABORT,'immutable_activity_code'); END;
--> statement-breakpoint
-- 用量: a 联网 红包's own 判定器 is that 红包's, which has addresses.
CREATE TRIGGER judge_usage_insert_guard BEFORE INSERT ON judge_usage
WHEN (NEW.activity_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM activities a JOIN activity_code c ON c.activity_id=a.id
   WHERE a.id=NEW.activity_id AND a.participation_mode='code' AND a.opened_at IS NOT NULL AND c.fingerprint=NEW.fingerprint))
 OR (NEW.networked=1 AND NOT EXISTS(SELECT 1 FROM activity_code c WHERE c.activity_id=NEW.activity_id
   AND c.protocol=NEW.protocol AND c.network IS NOT NULL))
BEGIN SELECT RAISE(ABORT,'invalid_judge_usage'); END;
--> statement-breakpoint
CREATE TRIGGER judge_usage_update_guard BEFORE UPDATE ON judge_usage
WHEN NEW.day IS NOT OLD.day OR NEW.sandbox_id IS NOT OLD.sandbox_id OR NEW.fingerprint IS NOT OLD.fingerprint
 OR NEW.protocol IS NOT OLD.protocol OR NEW.networked IS NOT OLD.networked
 OR NEW.fresh IS NOT OLD.fresh OR NEW.user_id IS NOT OLD.user_id OR NEW.first_at IS NOT OLD.first_at
 OR (OLD.activity_id IS NOT NULL AND NEW.activity_id IS NOT OLD.activity_id)
 OR (OLD.activity_id IS NULL AND NEW.activity_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM activities a
   JOIN activity_code c ON c.activity_id=a.id
   WHERE a.id=NEW.activity_id AND a.participation_mode='code' AND a.opened_at IS NOT NULL AND c.fingerprint=NEW.fingerprint))
 OR NEW.deploys<OLD.deploys OR NEW.reruns<OLD.reruns OR NEW.claims<OLD.claims OR NEW.timeouts<OLD.timeouts
 OR NEW.switches<OLD.switches OR NEW.fetches<OLD.fetches OR NEW.last_at<OLD.last_at
BEGIN SELECT RAISE(ABORT,'invalid_judge_usage'); END;
--> statement-breakpoint
CREATE TRIGGER judge_usage_delete_guard BEFORE DELETE ON judge_usage
WHEN OLD.day>=strftime('%Y-%m-%d','now','-90 days')
BEGIN SELECT RAISE(ABORT,'judge_usage_kept_90_days'); END;
--> statement-breakpoint
-- A run is protocol 1 or 2; the same code run again by its sender is a
-- rerun whichever protocol it ran on before (§9.1). Its addresses are
-- written once, when it finishes.
DROP TRIGGER judge_checks_insert_guard;
--> statement-breakpoint
CREATE TRIGGER judge_checks_insert_guard BEFORE INSERT ON judge_checks
WHEN NEW.protocol NOT IN (1,2) OR length(NEW.fingerprint)!=64 OR length(NEW.tests_digest)!=64 OR NEW.passed NOT IN (0,1)
 OR (NEW.passed=1 AND NEW.finished_at IS NULL)
 OR (NEW.finished_at IS NOT NULL AND (typeof(NEW.finished_at)!='integer' OR NEW.finished_at<NEW.created_at))
 OR (NEW.network IS NOT NULL AND (NEW.protocol!=2 OR NOT json_valid(NEW.network) OR json_type(NEW.network)!='array'
   OR json_array_length(NEW.network) NOT BETWEEN 1 AND 3))
 OR NEW.kind IS NOT (CASE WHEN EXISTS(SELECT 1 FROM judge_checks WHERE user_id=NEW.user_id
   AND fingerprint=NEW.fingerprint) THEN 'rerun' ELSE 'deploy' END)
BEGIN SELECT RAISE(ABORT,'invalid_judge_check'); END;
--> statement-breakpoint
DROP TRIGGER judge_checks_immutable;
--> statement-breakpoint
CREATE TRIGGER judge_checks_immutable BEFORE UPDATE ON judge_checks
WHEN OLD.finished_at IS NOT NULL OR NEW.finished_at IS NULL OR typeof(NEW.finished_at)!='integer'
 OR NEW.finished_at<OLD.created_at OR NEW.passed NOT IN (0,1)
 OR NEW.id IS NOT OLD.id OR NEW.user_id IS NOT OLD.user_id OR NEW.protocol IS NOT OLD.protocol
 OR NEW.fingerprint IS NOT OLD.fingerprint OR NEW.tests_digest IS NOT OLD.tests_digest
 OR NEW.kind IS NOT OLD.kind OR NEW.created_at IS NOT OLD.created_at
 OR (NEW.network IS NOT OLD.network AND (OLD.network IS NOT NULL OR NEW.protocol!=2 OR NOT json_valid(NEW.network)
   OR json_type(NEW.network)!='array' OR json_array_length(NEW.network) NOT BETWEEN 1 AND 3))
BEGIN SELECT RAISE(ABORT,'immutable_judge_check'); END;
--> statement-breakpoint
PRAGMA defer_foreign_keys=OFF;
