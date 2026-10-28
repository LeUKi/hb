-- 判定器 (docs/judge-square-design.md, 2026-10-28): code protocol v3 with
-- params (§3–§5), and 判定器 as things of their own (§1) — a name, a line,
-- whether the code is public before a 红包 ends, and every version
-- deployed into it, kept with the tests of its last run. A 红包's code
-- names its 判定器 and version, and keeps its sender's params; from opening
-- the params everyone sees and the secret ones' 封存值, the secret ones in
-- the clear once it is over. check() and 试一试 runs are counted (tries).
-- activity_code and 用量 take protocol 3 (联网 from 2 on): SQLite rebuilds
-- them, and the triggers on them, and those elsewhere that read them, are
-- made again as they were, with 判定器 and params where they belong. A 红包
-- opened before 判定器 is given its own once (judge_id from NULL), and
-- keeps it.
PRAGMA defer_foreign_keys=ON;--> statement-breakpoint
DROP TRIGGER activities_participation_open_guard;--> statement-breakpoint
DROP TRIGGER activity_code_delete_guard;--> statement-breakpoint
DROP TRIGGER activity_code_insert_guard;--> statement-breakpoint
DROP TRIGGER activity_code_update_guard;--> statement-breakpoint
DROP TRIGGER code_judgments_insert_guard;--> statement-breakpoint
DROP TRIGGER judge_usage_delete_guard;--> statement-breakpoint
DROP TRIGGER judge_usage_insert_guard;--> statement-breakpoint
DROP TRIGGER judge_usage_update_guard;--> statement-breakpoint
DROP TRIGGER reward_inventory_code_insert_guard;--> statement-breakpoint
CREATE TABLE `judge_tries` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`kind` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "judge_tries_shape" CHECK("judge_tries"."kind" IN ('check', 'try') AND typeof("judge_tries"."created_at") = 'integer')
);
--> statement-breakpoint
CREATE INDEX `judge_tries_user_time_idx` ON `judge_tries` (`user_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `judge_versions` (
	`judge_id` text NOT NULL,
	`n` integer NOT NULL,
	`fingerprint` text NOT NULL,
	`code_ciphertext` text NOT NULL,
	`protocol` integer NOT NULL,
	`tests_ciphertext` text NOT NULL,
	`tests_digest` text NOT NULL,
	`passed` integer NOT NULL,
	`declarations` text,
	`network` text,
	`deployed_at` integer NOT NULL,
	`checked_at` integer NOT NULL,
	PRIMARY KEY(`judge_id`, `n`),
	FOREIGN KEY (`judge_id`) REFERENCES `judges`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "judge_versions_shape" CHECK(typeof("judge_versions"."n") = 'integer' AND "judge_versions"."n" >= 1
        AND length("judge_versions"."fingerprint") = 64 AND length("judge_versions"."tests_digest") = 64
        AND "judge_versions"."protocol" IN (1, 2, 3) AND "judge_versions"."passed" IN (0, 1)
        AND ("judge_versions"."declarations" IS NULL OR ("judge_versions"."protocol" >= 3 AND json_valid("judge_versions"."declarations")))
        AND ("judge_versions"."network" IS NULL OR ("judge_versions"."protocol" >= 2 AND json_valid("judge_versions"."network")
          AND json_type("judge_versions"."network") = 'array' AND json_array_length("judge_versions"."network") BETWEEN 1 AND 3))
        AND typeof("judge_versions"."deployed_at") = 'integer' AND typeof("judge_versions"."checked_at") = 'integer'
        AND "judge_versions"."deployed_at" <= "judge_versions"."checked_at")
);
--> statement-breakpoint
CREATE UNIQUE INDEX `judge_versions_code_unique` ON `judge_versions` (`judge_id`,`fingerprint`);--> statement-breakpoint
CREATE TABLE `judges` (
	`id` text PRIMARY KEY NOT NULL,
	`author_id` text NOT NULL,
	`name` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`code_public` text DEFAULT 'ended' NOT NULL,
	`based_on_judge_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`author_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`based_on_judge_id`) REFERENCES `judges`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "judges_shape" CHECK(length("judges"."name") BETWEEN 1 AND 20 AND "judges"."name" = trim("judges"."name")
        AND length("judges"."description") <= 60 AND "judges"."description" = trim("judges"."description")
        AND "judges"."code_public" IN ('ended', 'always')
        AND typeof("judges"."created_at") = 'integer' AND typeof("judges"."updated_at") = 'integer')
);
--> statement-breakpoint
CREATE INDEX `judges_author_idx` ON `judges` (`author_id`,`updated_at`);--> statement-breakpoint
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
	`judge_id` text,
	`judge_version` integer,
	`params_ciphertext` text,
	`params_public` text,
	`params_commitment` text,
	`params_salt_ciphertext` text,
	`params_secret` text,
	`params_salt` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`activity_id`) REFERENCES `activities`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`stopped_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`judge_id`) REFERENCES `judges`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "activity_code_shape" CHECK("__new_activity_code"."protocol" IN (1, 2, 3) AND length("__new_activity_code"."fingerprint") = 64 AND length("__new_activity_code"."tests_digest") = 64
        AND ("__new_activity_code"."network" IS NULL OR ("__new_activity_code"."protocol" >= 2 AND json_valid("__new_activity_code"."network")
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
        AND ("__new_activity_code"."seed" IS NULL OR length("__new_activity_code"."seed") = 64)
        AND ("__new_activity_code"."judge_version" IS NULL OR ("__new_activity_code"."judge_id" IS NOT NULL
          AND typeof("__new_activity_code"."judge_version") = 'integer' AND "__new_activity_code"."judge_version" >= 1))
        AND ("__new_activity_code"."params_public" IS NULL OR json_valid("__new_activity_code"."params_public"))
        AND ("__new_activity_code"."params_commitment" IS NULL) = ("__new_activity_code"."params_salt_ciphertext" IS NULL)
        AND ("__new_activity_code"."params_commitment" IS NULL OR length("__new_activity_code"."params_commitment") = 64)
        AND ("__new_activity_code"."params_secret" IS NULL) = ("__new_activity_code"."params_salt" IS NULL)
        AND ("__new_activity_code"."params_secret" IS NULL OR ("__new_activity_code"."params_commitment" IS NOT NULL
          AND "__new_activity_code"."revealed_at" IS NOT NULL AND json_valid("__new_activity_code"."params_secret"))))
);
--> statement-breakpoint
INSERT INTO `__new_activity_code`("activity_id", "protocol", "prompt", "fingerprint", "code_ciphertext", "tests_ciphertext", "tests_digest", "min_each_minor", "seed_commitment", "seed_ciphertext", "state_ciphertext", "failures_in_row", "sandbox", "paused_at", "stopped_at", "stopped_by_user_id", "code", "seed", "revealed_at", "versions_ciphertext", "network", "created_at", "updated_at") SELECT "activity_id", "protocol", "prompt", "fingerprint", "code_ciphertext", "tests_ciphertext", "tests_digest", "min_each_minor", "seed_commitment", "seed_ciphertext", "state_ciphertext", "failures_in_row", "sandbox", "paused_at", "stopped_at", "stopped_by_user_id", "code", "seed", "revealed_at", "versions_ciphertext", "network", "created_at", "updated_at" FROM `activity_code`;--> statement-breakpoint
DROP TABLE `activity_code`;--> statement-breakpoint
ALTER TABLE `__new_activity_code` RENAME TO `activity_code`;--> statement-breakpoint
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
	`tries` integer DEFAULT 0 NOT NULL,
	`first_at` integer NOT NULL,
	`last_at` integer NOT NULL,
	PRIMARY KEY(`day`, `sandbox_id`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`activity_id`) REFERENCES `activities`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "judge_usage_shape" CHECK(length("__new_judge_usage"."fingerprint") = 64
        AND "__new_judge_usage"."protocol" IN (1, 2, 3) AND "__new_judge_usage"."networked" IN (0, 1)
        AND ("__new_judge_usage"."networked" = 0 OR ("__new_judge_usage"."protocol" >= 2 AND "__new_judge_usage"."activity_id" IS NOT NULL))
        AND typeof("__new_judge_usage"."fresh") = 'integer' AND "__new_judge_usage"."fresh" BETWEEN 0 AND 3
        AND "__new_judge_usage"."sandbox_id" = 'judge:v' || "__new_judge_usage"."protocol" || ':' || "__new_judge_usage"."fingerprint"
          || CASE WHEN "__new_judge_usage"."networked" = 1 THEN ':' || "__new_judge_usage"."activity_id" ELSE '' END
          || CASE WHEN "__new_judge_usage"."fresh" > 0 THEN ':' || "__new_judge_usage"."fresh" ELSE '' END
        AND typeof("__new_judge_usage"."fetches") = 'integer' AND "__new_judge_usage"."fetches" >= 0
        AND typeof("__new_judge_usage"."tries") = 'integer' AND "__new_judge_usage"."tries" >= 0
        AND typeof("__new_judge_usage"."first_at") = 'integer' AND typeof("__new_judge_usage"."last_at") = 'integer' AND "__new_judge_usage"."first_at" <= "__new_judge_usage"."last_at"
        AND "__new_judge_usage"."day" = strftime('%Y-%m-%d', "__new_judge_usage"."first_at" / 1000, 'unixepoch')
        AND typeof("__new_judge_usage"."deploys") = 'integer' AND "__new_judge_usage"."deploys" >= 0
        AND typeof("__new_judge_usage"."reruns") = 'integer' AND "__new_judge_usage"."reruns" >= 0
        AND typeof("__new_judge_usage"."claims") = 'integer' AND "__new_judge_usage"."claims" >= 0
        AND typeof("__new_judge_usage"."timeouts") = 'integer' AND "__new_judge_usage"."timeouts" >= 0
        AND typeof("__new_judge_usage"."switches") = 'integer' AND "__new_judge_usage"."switches" BETWEEN 0 AND "__new_judge_usage"."timeouts")
);
--> statement-breakpoint
INSERT INTO `__new_judge_usage`("day", "sandbox_id", "protocol", "fingerprint", "networked", "fresh", "user_id", "activity_id", "deploys", "reruns", "claims", "timeouts", "switches", "fetches", "first_at", "last_at") SELECT "day", "sandbox_id", "protocol", "fingerprint", "networked", "fresh", "user_id", "activity_id", "deploys", "reruns", "claims", "timeouts", "switches", "fetches", "first_at", "last_at" FROM `judge_usage`;--> statement-breakpoint
DROP TABLE `judge_usage`;--> statement-breakpoint
ALTER TABLE `__new_judge_usage` RENAME TO `judge_usage`;--> statement-breakpoint
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
CREATE TRIGGER activity_code_delete_guard BEFORE DELETE ON activity_code
WHEN EXISTS(SELECT 1 FROM activities WHERE id=OLD.activity_id AND opened_at IS NOT NULL)
BEGIN SELECT RAISE(ABORT,'immutable_activity_code'); END;
--> statement-breakpoint
CREATE TRIGGER activity_code_insert_guard BEFORE INSERT ON activity_code
WHEN NOT EXISTS(SELECT 1 FROM activities WHERE id=NEW.activity_id AND participation_mode='code'
   AND opened_at IS NULL AND deleted_at IS NULL)
 OR NEW.seed_commitment IS NOT NULL OR NEW.state_ciphertext IS NOT NULL OR NEW.failures_in_row!=0
 OR NEW.sandbox!=0 OR NEW.paused_at IS NOT NULL OR NEW.stopped_at IS NOT NULL OR NEW.revealed_at IS NOT NULL
 OR NEW.network IS NOT NULL OR NEW.params_public IS NOT NULL OR NEW.params_commitment IS NOT NULL
 OR NEW.params_secret IS NOT NULL
 OR (NEW.judge_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM judges j JOIN activities a ON a.id=NEW.activity_id
   WHERE j.id=NEW.judge_id AND j.author_id=a.author_id))
 OR (NEW.judge_version IS NOT NULL AND NOT EXISTS(SELECT 1 FROM judge_versions v
   WHERE v.judge_id=NEW.judge_id AND v.n=NEW.judge_version AND v.fingerprint=NEW.fingerprint))
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
   OR NEW.versions_ciphertext IS NOT OLD.versions_ciphertext OR NEW.network IS NOT OLD.network
   OR (OLD.judge_id IS NOT NULL AND (NEW.judge_id IS NOT OLD.judge_id OR NEW.judge_version IS NOT OLD.judge_version))
   OR NEW.params_ciphertext IS NOT OLD.params_ciphertext OR NEW.params_public IS NOT OLD.params_public
   OR NEW.params_commitment IS NOT OLD.params_commitment OR NEW.params_salt_ciphertext IS NOT OLD.params_salt_ciphertext))
 OR (NOT EXISTS(SELECT 1 FROM activities WHERE id=OLD.activity_id AND opened_at IS NOT NULL) AND (
   NEW.state_ciphertext IS NOT NULL OR NEW.failures_in_row!=0 OR NEW.sandbox!=0 OR NEW.paused_at IS NOT NULL
   OR NEW.stopped_at IS NOT NULL OR NEW.revealed_at IS NOT NULL OR NEW.params_secret IS NOT NULL))
 OR (OLD.paused_at IS NOT NULL AND NEW.paused_at IS NOT OLD.paused_at)
 OR (OLD.stopped_at IS NOT NULL AND (NEW.stopped_at IS NOT OLD.stopped_at OR NEW.stopped_by_user_id IS NOT OLD.stopped_by_user_id))
 OR (OLD.revealed_at IS NOT NULL AND (NEW.code IS NOT OLD.code OR NEW.seed IS NOT OLD.seed OR NEW.revealed_at IS NOT OLD.revealed_at
   OR NEW.params_secret IS NOT OLD.params_secret OR NEW.params_salt IS NOT OLD.params_salt))
 OR ((NEW.judge_id IS NOT OLD.judge_id OR NEW.judge_version IS NOT OLD.judge_version OR NEW.fingerprint IS NOT OLD.fingerprint) AND (
   (NEW.judge_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM judges j JOIN activities a ON a.id=NEW.activity_id
      WHERE j.id=NEW.judge_id AND j.author_id=a.author_id))
    OR (NEW.judge_version IS NOT NULL AND NOT EXISTS(SELECT 1 FROM judge_versions v
      WHERE v.judge_id=NEW.judge_id AND v.n=NEW.judge_version AND v.fingerprint=NEW.fingerprint))))
 OR (OLD.revealed_at IS NULL AND NEW.revealed_at IS NOT NULL AND NOT EXISTS(SELECT 1 FROM activities a
   WHERE a.id=OLD.activity_id AND a.opened_at IS NOT NULL AND (a.ended_at IS NOT NULL OR a.claimed_count>=a.total_count
     OR a.deadline<=CAST((julianday('now')-2440587.5)*86400000 AS INTEGER))))
BEGIN SELECT RAISE(ABORT,'immutable_activity_code'); END;
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
CREATE TRIGGER judge_usage_delete_guard BEFORE DELETE ON judge_usage
WHEN OLD.day>=strftime('%Y-%m-%d','now','-90 days')
BEGIN SELECT RAISE(ABORT,'judge_usage_kept_90_days'); END;
--> statement-breakpoint
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
 OR NEW.switches<OLD.switches OR NEW.fetches<OLD.fetches OR NEW.tries<OLD.tries OR NEW.last_at<OLD.last_at
BEGIN SELECT RAISE(ABORT,'invalid_judge_usage'); END;
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
--> statement-breakpoint
-- A 判定器 keeps its author and when it was made; its code goes public
-- once and for good (§2). None is deleted (§12).
CREATE TRIGGER judges_update_guard BEFORE UPDATE ON judges
WHEN NEW.id IS NOT OLD.id OR NEW.author_id IS NOT OLD.author_id OR NEW.created_at IS NOT OLD.created_at
 OR NEW.based_on_judge_id IS NOT OLD.based_on_judge_id OR NEW.updated_at < OLD.updated_at
 OR (OLD.code_public='always' AND NEW.code_public IS NOT 'always')
BEGIN SELECT RAISE(ABORT,'immutable_judge'); END;
--> statement-breakpoint
CREATE TRIGGER judges_delete_guard BEFORE DELETE ON judges
BEGIN SELECT RAISE(ABORT,'immutable_judge'); END;
--> statement-breakpoint
-- A version comes after the last; it passed only if its author's run of
-- its code and tests on its protocol passed, and its code never changes.
CREATE TRIGGER judge_versions_insert_guard BEFORE INSERT ON judge_versions
WHEN NEW.n <= COALESCE((SELECT MAX(n) FROM judge_versions WHERE judge_id=NEW.judge_id), 0)
 OR (NEW.passed=1 AND NOT EXISTS(SELECT 1 FROM judge_checks k JOIN judges j ON j.id=NEW.judge_id
   WHERE k.user_id=j.author_id AND k.protocol=NEW.protocol AND k.fingerprint=NEW.fingerprint
     AND k.tests_digest=NEW.tests_digest AND k.passed=1))
BEGIN SELECT RAISE(ABORT,'invalid_judge_version'); END;
--> statement-breakpoint
CREATE TRIGGER judge_versions_update_guard BEFORE UPDATE ON judge_versions
WHEN NEW.judge_id IS NOT OLD.judge_id OR NEW.n IS NOT OLD.n OR NEW.fingerprint IS NOT OLD.fingerprint
 OR NEW.code_ciphertext IS NOT OLD.code_ciphertext OR NEW.deployed_at IS NOT OLD.deployed_at
 OR NEW.checked_at < OLD.checked_at
 OR (NEW.passed=1 AND NOT EXISTS(SELECT 1 FROM judge_checks k JOIN judges j ON j.id=NEW.judge_id
   WHERE k.user_id=j.author_id AND k.protocol=NEW.protocol AND k.fingerprint=NEW.fingerprint
     AND k.tests_digest=NEW.tests_digest AND k.passed=1))
BEGIN SELECT RAISE(ABORT,'immutable_judge_version'); END;
--> statement-breakpoint
CREATE TRIGGER judge_versions_delete_guard BEFORE DELETE ON judge_versions
BEGIN SELECT RAISE(ABORT,'immutable_judge_version'); END;
--> statement-breakpoint
-- A run may be on protocol 3, and from 2 on may have 联网.
DROP TRIGGER judge_checks_insert_guard;
--> statement-breakpoint
CREATE TRIGGER judge_checks_insert_guard BEFORE INSERT ON judge_checks
WHEN NEW.protocol NOT IN (1,2,3) OR length(NEW.fingerprint)!=64 OR length(NEW.tests_digest)!=64 OR NEW.passed NOT IN (0,1)
 OR (NEW.passed=1 AND NEW.finished_at IS NULL)
 OR (NEW.finished_at IS NOT NULL AND (typeof(NEW.finished_at)!='integer' OR NEW.finished_at<NEW.created_at))
 OR (NEW.network IS NOT NULL AND (NEW.protocol<2 OR NOT json_valid(NEW.network) OR json_type(NEW.network)!='array'
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
 OR (NEW.network IS NOT OLD.network AND (OLD.network IS NOT NULL OR NEW.protocol<2 OR NOT json_valid(NEW.network)
   OR json_type(NEW.network)!='array' OR json_array_length(NEW.network) NOT BETWEEN 1 AND 3))
BEGIN SELECT RAISE(ABORT,'immutable_judge_check'); END;
--> statement-breakpoint
PRAGMA defer_foreign_keys=OFF;
