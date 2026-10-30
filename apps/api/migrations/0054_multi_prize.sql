-- 能赢好几次的代码判定红包 (docs/multi-prize-design.md, 2026-10-30): code
-- protocol 5 — each person has pending, their own state and view, and is
-- settled once, by the code or as the 红包 ends (结算中 until everyone is,
-- then the rest goes back). code_judge_people keeps each one's part,
-- code_judgment_moves what each judgment moved, code_judgments what it wrote
-- (ledger_ciphertext); activity_code everyone's pending together, kept by
-- triggers, and when the settling was done. activity_code, judge_usage and
-- judge_versions take protocol 5: SQLite rebuilds them with code_judge_people,
-- and the triggers on them and those elsewhere that read them are made
-- again, protocol 5's rules added; a claim on protocol 5 settles someone
-- with exactly their pending, also after the end, and a 🐟额红包 gives back
-- only once everyone is settled. Drafts of 代码判定红包 open on the new rules:
-- no shares, total_count the pool in 分 (at most one claim per 0.01).
PRAGMA defer_foreign_keys=ON;
--> statement-breakpoint
DROP TRIGGER activities_participation_open_guard;
--> statement-breakpoint
DROP TRIGGER activity_announcements_insert_guard;
--> statement-breakpoint
DROP TRIGGER activity_code_delete_guard;
--> statement-breakpoint
DROP TRIGGER activity_code_insert_guard;
--> statement-breakpoint
DROP TRIGGER activity_code_update_guard;
--> statement-breakpoint
DROP TRIGGER code_judgments_insert_guard;
--> statement-breakpoint
DROP TRIGGER judge_features_insert_guard;
--> statement-breakpoint
DROP TRIGGER judge_features_update_guard;
--> statement-breakpoint
DROP TRIGGER judge_usage_delete_guard;
--> statement-breakpoint
DROP TRIGGER judge_usage_insert_guard;
--> statement-breakpoint
DROP TRIGGER judge_usage_update_guard;
--> statement-breakpoint
DROP TRIGGER judge_versions_delete_guard;
--> statement-breakpoint
DROP TRIGGER judge_versions_insert_guard;
--> statement-breakpoint
DROP TRIGGER judge_versions_update_guard;
--> statement-breakpoint
DROP TRIGGER reward_inventory_code_insert_guard;
--> statement-breakpoint
DROP TRIGGER claims_participation_insert_guard;
--> statement-breakpoint
DROP TRIGGER balance_entries_lock_guard;
--> statement-breakpoint
CREATE TABLE `code_judgment_moves` (
	`submission_row_id` text NOT NULL,
	`position` integer NOT NULL,
	`activity_id` text NOT NULL,
	`user_id` text NOT NULL,
	`add_minor` integer NOT NULL,
	`before_minor` integer NOT NULL,
	`after_minor` integer NOT NULL,
	`settles` integer NOT NULL,
	`message` text,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`submission_row_id`, `position`),
	FOREIGN KEY (`submission_row_id`) REFERENCES `code_judgments`(`submission_row_id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`activity_id`) REFERENCES `activities`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "code_judgment_moves_shape" CHECK(typeof("code_judgment_moves"."position") = 'integer' AND "code_judgment_moves"."position" BETWEEN 0 AND 10
        AND typeof("code_judgment_moves"."add_minor") = 'integer'
        AND typeof("code_judgment_moves"."before_minor") = 'integer' AND "code_judgment_moves"."before_minor" >= 0
        AND typeof("code_judgment_moves"."after_minor") = 'integer' AND "code_judgment_moves"."after_minor" >= 0
        AND ("code_judgment_moves"."message" IS NULL OR ("code_judgment_moves"."position" > 0 AND length("code_judgment_moves"."message") BETWEEN 1 AND 100))
        AND typeof("code_judgment_moves"."created_at") = 'integer')
);
--> statement-breakpoint
CREATE UNIQUE INDEX `code_judgment_moves_person_unique` ON `code_judgment_moves` (`submission_row_id`,`user_id`);--> statement-breakpoint
CREATE INDEX `code_judgment_moves_person_idx` ON `code_judgment_moves` (`activity_id`,`user_id`,`created_at`);--> statement-breakpoint
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
	`network_ack` text,
	`view_summary` text,
	`view_data` text,
	`view_at` integer,
	`setup_ciphertext` text,
	`pending_minor` integer DEFAULT 0 NOT NULL,
	`settled_at` integer,
	FOREIGN KEY (`activity_id`) REFERENCES `activities`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`stopped_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`judge_id`) REFERENCES `judges`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "activity_code_shape" CHECK("__new_activity_code"."protocol" IN (1, 2, 3, 4, 5) AND length("__new_activity_code"."fingerprint") = 64 AND length("__new_activity_code"."tests_digest") = 64
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
          AND "__new_activity_code"."revealed_at" IS NOT NULL AND json_valid("__new_activity_code"."params_secret")))
        AND ("__new_activity_code"."view_summary" IS NULL OR length("__new_activity_code"."view_summary") BETWEEN 1 AND 200)
        AND ("__new_activity_code"."view_data" IS NULL OR (json_valid("__new_activity_code"."view_data") AND length(CAST("__new_activity_code"."view_data" AS BLOB)) <= 16384))
        AND ("__new_activity_code"."view_at" IS NULL OR ("__new_activity_code"."protocol" >= 4 AND typeof("__new_activity_code"."view_at") = 'integer'))
        AND (("__new_activity_code"."view_summary" IS NULL AND "__new_activity_code"."view_data" IS NULL) OR "__new_activity_code"."view_at" IS NOT NULL)
        AND ("__new_activity_code"."setup_ciphertext" IS NULL OR "__new_activity_code"."protocol" >= 4)
        AND typeof("__new_activity_code"."pending_minor") = 'integer' AND "__new_activity_code"."pending_minor" >= 0
        AND ("__new_activity_code"."protocol" >= 5 OR ("__new_activity_code"."pending_minor" = 0 AND "__new_activity_code"."settled_at" IS NULL))
        AND ("__new_activity_code"."settled_at" IS NULL OR (typeof("__new_activity_code"."settled_at") = 'integer' AND "__new_activity_code"."pending_minor" = 0)))
);
--> statement-breakpoint
INSERT INTO `__new_activity_code`("activity_id", "protocol", "prompt", "fingerprint", "code_ciphertext", "tests_ciphertext", "tests_digest", "min_each_minor", "seed_commitment", "seed_ciphertext", "state_ciphertext", "failures_in_row", "sandbox", "paused_at", "stopped_at", "stopped_by_user_id", "code", "seed", "revealed_at", "versions_ciphertext", "network", "judge_id", "judge_version", "params_ciphertext", "params_public", "params_commitment", "params_salt_ciphertext", "params_secret", "params_salt", "created_at", "updated_at", "network_ack", "view_summary", "view_data", "view_at", "setup_ciphertext") SELECT "activity_id", "protocol", "prompt", "fingerprint", "code_ciphertext", "tests_ciphertext", "tests_digest", "min_each_minor", "seed_commitment", "seed_ciphertext", "state_ciphertext", "failures_in_row", "sandbox", "paused_at", "stopped_at", "stopped_by_user_id", "code", "seed", "revealed_at", "versions_ciphertext", "network", "judge_id", "judge_version", "params_ciphertext", "params_public", "params_commitment", "params_salt_ciphertext", "params_secret", "params_salt", "created_at", "updated_at", "network_ack", "view_summary", "view_data", "view_at", "setup_ciphertext" FROM `activity_code`;--> statement-breakpoint
DROP TABLE `activity_code`;--> statement-breakpoint
ALTER TABLE `__new_activity_code` RENAME TO `activity_code`;--> statement-breakpoint
CREATE INDEX `activity_code_judge_idx` ON `activity_code` (`judge_id`,`judge_version`);--> statement-breakpoint
CREATE INDEX `activity_code_settling_idx` ON `activity_code` (`activity_id`) WHERE "activity_code"."protocol" >= 5 AND "activity_code"."settled_at" IS NULL;--> statement-breakpoint
CREATE TABLE `__new_code_judge_people` (
	`activity_id` text NOT NULL,
	`user_id` text NOT NULL,
	`judged` integer NOT NULL,
	`claimed` integer NOT NULL,
	`paid_minor` integer,
	`first_at` integer NOT NULL,
	`last_at` integer NOT NULL,
	`pending_minor` integer DEFAULT 0 NOT NULL,
	`own_state_ciphertext` text,
	`own_view_ciphertext` text,
	`settled_at` integer,
	`settled_minor` integer,
	`claim_id` text,
	PRIMARY KEY(`activity_id`, `user_id`),
	FOREIGN KEY (`activity_id`) REFERENCES `activities`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`claim_id`) REFERENCES `claims`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "code_judge_people_shape" CHECK(typeof("__new_code_judge_people"."judged") = 'integer' AND "__new_code_judge_people"."judged" >= 1
        AND (("__new_code_judge_people"."claimed" = 1 AND typeof("__new_code_judge_people"."paid_minor") = 'integer' AND "__new_code_judge_people"."paid_minor" > 0)
          OR ("__new_code_judge_people"."claimed" = 0 AND "__new_code_judge_people"."paid_minor" IS NULL))
        AND typeof("__new_code_judge_people"."first_at") = 'integer' AND "__new_code_judge_people"."last_at" >= "__new_code_judge_people"."first_at"
        AND typeof("__new_code_judge_people"."pending_minor") = 'integer' AND "__new_code_judge_people"."pending_minor" >= 0
        AND (("__new_code_judge_people"."settled_at" IS NULL AND "__new_code_judge_people"."settled_minor" IS NULL AND "__new_code_judge_people"."claim_id" IS NULL)
          OR (typeof("__new_code_judge_people"."settled_at") = 'integer' AND typeof("__new_code_judge_people"."settled_minor") = 'integer'
            AND "__new_code_judge_people"."settled_minor" >= 0 AND "__new_code_judge_people"."pending_minor" = 0
            AND ("__new_code_judge_people"."settled_minor" > 0) = ("__new_code_judge_people"."claim_id" IS NOT NULL)
            AND "__new_code_judge_people"."claimed" = ("__new_code_judge_people"."settled_minor" > 0)
            AND "__new_code_judge_people"."paid_minor" IS NULLIF("__new_code_judge_people"."settled_minor", 0))))
);
--> statement-breakpoint
INSERT INTO `__new_code_judge_people`("activity_id", "user_id", "judged", "claimed", "paid_minor", "first_at", "last_at") SELECT "activity_id", "user_id", "judged", "claimed", "paid_minor", "first_at", "last_at" FROM `code_judge_people`;--> statement-breakpoint
DROP TABLE `code_judge_people`;--> statement-breakpoint
ALTER TABLE `__new_code_judge_people` RENAME TO `code_judge_people`;--> statement-breakpoint
CREATE INDEX `code_judge_people_recent_idx` ON `code_judge_people` (`activity_id`,`last_at`,`user_id`);--> statement-breakpoint
CREATE INDEX `code_judge_people_most_idx` ON `code_judge_people` (`activity_id`,`judged`,`last_at`,`user_id`);--> statement-breakpoint
CREATE INDEX `code_judge_people_claimed_idx` ON `code_judge_people` (`activity_id`,`claimed`,`last_at`,`user_id`);--> statement-breakpoint
CREATE INDEX `code_judge_people_unsettled_idx` ON `code_judge_people` (`activity_id`,`first_at`,`user_id`) WHERE "code_judge_people"."settled_at" IS NULL;--> statement-breakpoint
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
        AND "__new_judge_usage"."protocol" IN (1, 2, 3, 4, 5) AND "__new_judge_usage"."networked" IN (0, 1)
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
INSERT INTO `__new_judge_usage`("day", "sandbox_id", "protocol", "fingerprint", "networked", "fresh", "user_id", "activity_id", "deploys", "reruns", "claims", "timeouts", "switches", "fetches", "tries", "first_at", "last_at") SELECT "day", "sandbox_id", "protocol", "fingerprint", "networked", "fresh", "user_id", "activity_id", "deploys", "reruns", "claims", "timeouts", "switches", "fetches", "tries", "first_at", "last_at" FROM `judge_usage`;--> statement-breakpoint
DROP TABLE `judge_usage`;--> statement-breakpoint
ALTER TABLE `__new_judge_usage` RENAME TO `judge_usage`;--> statement-breakpoint
CREATE TABLE `__new_judge_versions` (
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
	CONSTRAINT "judge_versions_shape" CHECK(typeof("__new_judge_versions"."n") = 'integer' AND "__new_judge_versions"."n" >= 1
        AND length("__new_judge_versions"."fingerprint") = 64 AND length("__new_judge_versions"."tests_digest") = 64
        AND "__new_judge_versions"."protocol" IN (1, 2, 3, 4, 5) AND "__new_judge_versions"."passed" IN (0, 1)
        AND ("__new_judge_versions"."declarations" IS NULL OR ("__new_judge_versions"."protocol" >= 3 AND json_valid("__new_judge_versions"."declarations")))
        AND ("__new_judge_versions"."network" IS NULL OR ("__new_judge_versions"."protocol" >= 2 AND json_valid("__new_judge_versions"."network")
          AND json_type("__new_judge_versions"."network") = 'array' AND json_array_length("__new_judge_versions"."network") BETWEEN 1 AND 3))
        AND typeof("__new_judge_versions"."deployed_at") = 'integer' AND typeof("__new_judge_versions"."checked_at") = 'integer'
        AND "__new_judge_versions"."deployed_at" <= "__new_judge_versions"."checked_at")
);
--> statement-breakpoint
INSERT INTO `__new_judge_versions`("judge_id", "n", "fingerprint", "code_ciphertext", "protocol", "tests_ciphertext", "tests_digest", "passed", "declarations", "network", "deployed_at", "checked_at") SELECT "judge_id", "n", "fingerprint", "code_ciphertext", "protocol", "tests_ciphertext", "tests_digest", "passed", "declarations", "network", "deployed_at", "checked_at" FROM `judge_versions`;--> statement-breakpoint
DROP TABLE `judge_versions`;--> statement-breakpoint
ALTER TABLE `__new_judge_versions` RENAME TO `judge_versions`;--> statement-breakpoint
CREATE UNIQUE INDEX `judge_versions_code_unique` ON `judge_versions` (`judge_id`,`fingerprint`);--> statement-breakpoint
ALTER TABLE `code_judgments` ADD `ledger_ciphertext` text;
--> statement-breakpoint
CREATE TRIGGER activities_participation_open_guard BEFORE UPDATE OF opened_at ON activities
WHEN OLD.opened_at IS NULL AND NEW.opened_at IS NOT NULL AND (
 (NEW.participation_mode='password' AND NOT EXISTS(SELECT 1 FROM activity_passwords WHERE activity_id=NEW.id))
 OR (NEW.participation_mode='direct' AND EXISTS(SELECT 1 FROM activity_passwords WHERE activity_id=NEW.id))
 OR (NEW.participation_mode='code' AND (EXISTS(SELECT 1 FROM activity_passwords WHERE activity_id=NEW.id)
   OR EXISTS(SELECT 1 FROM reward_inventory WHERE activity_id=NEW.id)
   OR NOT EXISTS(SELECT 1 FROM activity_code c JOIN judge_checks k ON k.user_id=COALESCE((SELECT author_id FROM judges WHERE id=c.judge_id), NEW.author_id)
     AND k.protocol=c.protocol AND k.fingerprint=c.fingerprint AND k.tests_digest=c.tests_digest AND k.passed=1
     WHERE c.activity_id=NEW.id AND c.seed_commitment IS NOT NULL)
   OR EXISTS(SELECT 1 FROM activity_code c JOIN judges j ON j.id=c.judge_id
     WHERE c.activity_id=NEW.id AND j.taken_down_at IS NOT NULL))))
BEGIN SELECT RAISE(ABORT,'invalid_participation_passwords'); END;
--> statement-breakpoint
CREATE TRIGGER activity_announcements_insert_guard BEFORE INSERT ON activity_announcements
WHEN NOT EXISTS(SELECT 1 FROM code_judgments j JOIN activity_code c ON c.activity_id=j.activity_id
   WHERE j.submission_row_id=NEW.submission_row_id AND j.activity_id=NEW.activity_id AND j.user_id=NEW.user_id
     AND c.protocol>=4)
 OR NEW.n IS NOT (SELECT COUNT(*) FROM activity_announcements WHERE activity_id=NEW.activity_id)
BEGIN SELECT RAISE(ABORT,'invalid_activity_announcement'); END;
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
 OR NEW.params_secret IS NOT NULL OR NEW.view_summary IS NOT NULL OR NEW.view_data IS NOT NULL
 OR NEW.view_at IS NOT NULL OR NEW.setup_ciphertext IS NOT NULL
 OR NEW.pending_minor!=0 OR NEW.settled_at IS NOT NULL
 OR (NEW.judge_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM judges j JOIN activities a ON a.id=NEW.activity_id
   WHERE j.id=NEW.judge_id AND (j.author_id=a.author_id OR (j.listed_at IS NOT NULL AND j.taken_down_at IS NULL)
     OR EXISTS(SELECT 1 FROM activity_code k WHERE k.activity_id=NEW.activity_id AND k.judge_id=NEW.judge_id))))
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
   OR NEW.stopped_at IS NOT NULL OR NEW.revealed_at IS NOT NULL OR NEW.params_secret IS NOT NULL
   OR NEW.view_summary IS NOT NULL OR NEW.view_data IS NOT NULL OR NEW.view_at IS NOT NULL
   OR NEW.setup_ciphertext IS NOT NULL OR NEW.pending_minor!=0 OR NEW.settled_at IS NOT NULL))
 OR (NEW.pending_minor>OLD.pending_minor AND NEW.pending_minor>COALESCE((SELECT CASE WHEN a.funding='balance'
         THEN (SELECT l.remaining_minor FROM balance_locks l WHERE l.activity_id=a.id AND l.purpose='activity' AND l.status='active')
         ELSE CAST(ROUND(CAST(json_extract(a.config,'$.money.totalAmount') AS REAL)*100) AS INTEGER)
           - COALESCE((SELECT SUM(r.amount_minor) FROM reward_inventory r WHERE r.activity_id=a.id),0)
       END
     FROM activities a WHERE a.id=OLD.activity_id),0))
 OR (OLD.settled_at IS NOT NULL AND (NEW.settled_at IS NOT OLD.settled_at OR NEW.pending_minor IS NOT OLD.pending_minor))
 OR (OLD.settled_at IS NULL AND NEW.settled_at IS NOT NULL AND (OLD.protocol<5
   OR NOT EXISTS(SELECT 1 FROM activities WHERE id=OLD.activity_id AND ended_at IS NOT NULL)
   OR EXISTS(SELECT 1 FROM code_judge_people WHERE activity_id=OLD.activity_id AND settled_at IS NULL)))
 OR (OLD.setup_ciphertext IS NOT NULL AND NEW.setup_ciphertext IS NOT OLD.setup_ciphertext)
 OR (OLD.view_at IS NOT NULL AND NEW.view_at IS NULL)
 OR (OLD.paused_at IS NOT NULL AND NEW.paused_at IS NOT OLD.paused_at)
 OR (OLD.stopped_at IS NOT NULL AND (NEW.stopped_at IS NOT OLD.stopped_at OR NEW.stopped_by_user_id IS NOT OLD.stopped_by_user_id))
 OR (OLD.revealed_at IS NOT NULL AND (NEW.code IS NOT OLD.code OR NEW.seed IS NOT OLD.seed OR NEW.revealed_at IS NOT OLD.revealed_at
   OR NEW.params_secret IS NOT OLD.params_secret OR NEW.params_salt IS NOT OLD.params_salt))
 OR ((NEW.judge_id IS NOT OLD.judge_id OR NEW.judge_version IS NOT OLD.judge_version OR NEW.fingerprint IS NOT OLD.fingerprint) AND (
   (NEW.judge_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM judges j JOIN activities a ON a.id=NEW.activity_id
      WHERE j.id=NEW.judge_id AND (j.author_id=a.author_id OR (j.listed_at IS NOT NULL AND j.taken_down_at IS NULL))))
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
 OR NEW.ends NOT IN (0,1)
 OR (NEW.view IS NOT NULL AND (NOT json_valid(NEW.view) OR length(CAST(NEW.view AS BLOB))>17408))
 OR ((NEW.ends=1 OR NEW.view IS NOT NULL) AND NOT EXISTS(SELECT 1 FROM activity_code
   WHERE activity_id=NEW.activity_id AND protocol>=4))
 OR (NEW.ok=1 AND EXISTS(SELECT 1 FROM activity_code WHERE activity_id=NEW.activity_id AND protocol>=5))
 OR ((NEW.ledger_ciphertext IS NOT NULL) != EXISTS(SELECT 1 FROM activity_code
   WHERE activity_id=NEW.activity_id AND protocol>=5))
 OR EXISTS(SELECT 1 FROM code_judge_people WHERE activity_id=NEW.activity_id AND user_id=NEW.user_id
   AND settled_at IS NOT NULL)
 OR NEW.attempt IS NOT (SELECT COUNT(*) FROM code_judgments WHERE activity_id=NEW.activity_id AND user_id=NEW.user_id)
 OR NEW.sequence IS NOT (SELECT COUNT(*) FROM code_judgments WHERE activity_id=NEW.activity_id)
BEGIN SELECT RAISE(ABORT,'invalid_code_judgment'); END;
--> statement-breakpoint
CREATE TRIGGER judge_features_insert_guard BEFORE INSERT ON judge_features
WHEN typeof(NEW.position)!='integer' OR NEW.position<0 OR typeof(NEW.created_at)!='integer'
 OR NEW.updated_at!=NEW.created_at
 OR NOT EXISTS(SELECT 1 FROM judge_versions v JOIN judges j ON j.id=v.judge_id
   WHERE v.judge_id=NEW.judge_id AND v.n=NEW.n AND v.passed=1 AND v.protocol>=3
     AND (j.featurable=1 OR j.author_id=NEW.created_by))
BEGIN SELECT RAISE(ABORT,'invalid_judge_feature'); END;
--> statement-breakpoint
CREATE TRIGGER judge_features_update_guard BEFORE UPDATE ON judge_features
WHEN NEW.judge_id IS NOT OLD.judge_id OR NEW.created_by IS NOT OLD.created_by OR NEW.created_at IS NOT OLD.created_at
 OR typeof(NEW.position)!='integer' OR NEW.position<0 OR NEW.updated_at<OLD.updated_at
 OR (NEW.n IS NOT OLD.n AND NOT EXISTS(SELECT 1 FROM judge_versions v
   WHERE v.judge_id=NEW.judge_id AND v.n=NEW.n AND v.passed=1 AND v.protocol>=3))
BEGIN SELECT RAISE(ABORT,'invalid_judge_feature'); END;
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
CREATE TRIGGER judge_versions_delete_guard BEFORE DELETE ON judge_versions
BEGIN SELECT RAISE(ABORT,'immutable_judge_version'); END;
--> statement-breakpoint
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
       AND c.stopped_at IS NULL AND c.protocol<5 AND a.claimed_count<a.total_count) s
   WHERE s.remaining IS NOT NULL AND NEW.kind='ldc' AND NEW.position=s.claimed
     AND ((s.claimed+1=s.total AND NEW.amount_minor=s.remaining)
       OR (s.claimed+1<s.total AND NEW.amount_minor>=s.min_each
         AND NEW.amount_minor<=s.remaining-(s.total-s.claimed-1)*s.min_each)))
 AND NOT EXISTS(SELECT 1 FROM (
     SELECT a.claimed_count AS claimed, CASE WHEN a.funding='balance'
           THEN (SELECT l.remaining_minor FROM balance_locks l WHERE l.activity_id=a.id AND l.purpose='activity' AND l.status='active')
           ELSE CAST(ROUND(CAST(json_extract(a.config,'$.money.totalAmount') AS REAL)*100) AS INTEGER)
             - COALESCE((SELECT SUM(r.amount_minor) FROM reward_inventory r WHERE r.activity_id=a.id),0)
         END AS remaining
     FROM activities a JOIN activity_code c ON c.activity_id=a.id
     WHERE a.id=NEW.activity_id AND a.opened_at IS NOT NULL AND a.deleted_at IS NULL
       AND c.protocol>=5 AND c.settled_at IS NULL AND a.claimed_count<a.total_count) s
   WHERE s.remaining IS NOT NULL AND NEW.kind='ldc' AND NEW.position=s.claimed
     AND NEW.amount_minor>=1 AND NEW.amount_minor<=s.remaining)
BEGIN SELECT RAISE(ABORT,'invalid_code_share'); END;
--> statement-breakpoint
CREATE TRIGGER claims_participation_insert_guard BEFORE INSERT ON claims
WHEN NOT EXISTS(SELECT 1 FROM activities a WHERE a.id=NEW.activity_id AND (
 (a.participation_mode='password' AND EXISTS(SELECT 1 FROM activity_passwords p WHERE p.id=NEW.password_id AND p.activity_id=a.id))
 OR (a.participation_mode='direct' AND NEW.password_id IS NULL AND (
   json_extract(a.config,'$.money.mode')='timed_draw'
   OR EXISTS(SELECT 1 FROM redemption_submissions s WHERE s.activity_id=a.id AND s.user_id=NEW.user_id
     AND s.participation_mode='direct' AND s.purpose='claim' AND s.outcome='pending' AND s.validated_at IS NOT NULL AND s.matched_password_id IS NULL)
 ))
 OR (a.participation_mode='code' AND NEW.password_id IS NULL AND EXISTS(SELECT 1 FROM redemption_submissions s
   JOIN code_judgments j ON j.submission_row_id=s.id
   JOIN reward_inventory r ON r.activity_id=a.id AND r.id=NEW.inventory_id
   WHERE s.activity_id=a.id AND s.user_id=NEW.user_id AND s.participation_mode='code' AND s.purpose='claim'
     AND s.outcome='pending' AND s.validated_at IS NOT NULL AND s.matched_password_id IS NULL
     AND j.ok=1 AND j.paid_minor=r.amount_minor))
 OR (a.participation_mode='code' AND NEW.password_id IS NULL
   AND EXISTS(SELECT 1 FROM activity_code c WHERE c.activity_id=a.id AND c.protocol>=5)
   AND EXISTS(SELECT 1 FROM code_judge_people p JOIN reward_inventory r ON r.activity_id=a.id AND r.id=NEW.inventory_id
     WHERE p.activity_id=a.id AND p.user_id=NEW.user_id AND p.settled_at IS NULL AND p.pending_minor=r.amount_minor))))
BEGIN SELECT RAISE(ABORT,'invalid_claim_participation'); END;
--> statement-breakpoint
CREATE TRIGGER balance_entries_lock_guard
BEFORE INSERT ON balance_entries
WHEN NEW.kind IN ('lock','unlock','deduct') AND NOT EXISTS (
  SELECT 1 FROM balance_locks l WHERE l.id=NEW.lock_id AND l.user_id=NEW.user_id AND l.status='active'
    AND ((NEW.kind='lock' AND l.remaining_minor=l.amount_minor AND NEW.locked_delta_minor=l.amount_minor)
      OR (NEW.kind='unlock' AND -NEW.locked_delta_minor=l.remaining_minor
        AND (l.purpose='withdrawal' OR EXISTS (SELECT 1 FROM activities a WHERE a.id=l.activity_id
          AND ((a.ended_at IS NOT NULL AND (a.draw_state IS NULL OR a.draw_state IN ('completed','empty'))
              AND NOT EXISTS(SELECT 1 FROM activity_code c WHERE c.activity_id=a.id AND c.protocol>=5 AND c.settled_at IS NULL))
            OR (a.opened_at IS NULL AND a.scheduled_open_at IS NULL)))))
      OR (NEW.kind='deduct' AND -NEW.locked_delta_minor<=l.remaining_minor
        AND ((l.purpose='withdrawal' AND NEW.claim_id IS NULL)
          OR (l.purpose='activity' AND EXISTS (SELECT 1 FROM claims c JOIN reward_inventory r ON r.activity_id=c.activity_id AND r.id=c.inventory_id
            WHERE c.id=NEW.claim_id AND c.activity_id=l.activity_id AND r.amount_minor=-NEW.locked_delta_minor))))))
BEGIN
  SELECT RAISE(ABORT, 'balance lock entry mismatch');
END;
--> statement-breakpoint
-- Protocol 5: each person's part moves only on a protocol 5 红包; it
-- starts unsettled, moves while the 红包 is open, and once settled, with
-- exactly the pending it had (and the claim that paid it, when not 0),
-- never again.
CREATE TRIGGER code_judge_people_insert_guard BEFORE INSERT ON code_judge_people
WHEN NEW.settled_at IS NOT NULL
 OR ((NEW.pending_minor!=0 OR NEW.own_state_ciphertext IS NOT NULL OR NEW.own_view_ciphertext IS NOT NULL)
   AND NOT EXISTS(SELECT 1 FROM activity_code WHERE activity_id=NEW.activity_id AND protocol>=5))
BEGIN SELECT RAISE(ABORT,'invalid_code_judge_person'); END;
--> statement-breakpoint
CREATE TRIGGER code_judge_people_update_guard BEFORE UPDATE ON code_judge_people
WHEN NEW.activity_id IS NOT OLD.activity_id OR NEW.user_id IS NOT OLD.user_id
 OR (OLD.settled_at IS NOT NULL AND (NEW.settled_at IS NOT OLD.settled_at OR NEW.settled_minor IS NOT OLD.settled_minor
   OR NEW.claim_id IS NOT OLD.claim_id OR NEW.pending_minor IS NOT OLD.pending_minor
   OR NEW.own_state_ciphertext IS NOT OLD.own_state_ciphertext OR NEW.own_view_ciphertext IS NOT OLD.own_view_ciphertext))
 OR ((NEW.pending_minor IS NOT OLD.pending_minor OR NEW.settled_at IS NOT OLD.settled_at
     OR NEW.own_state_ciphertext IS NOT OLD.own_state_ciphertext OR NEW.own_view_ciphertext IS NOT OLD.own_view_ciphertext)
   AND NOT EXISTS(SELECT 1 FROM activity_code WHERE activity_id=OLD.activity_id AND protocol>=5))
 OR (NEW.settled_at IS NULL AND NEW.pending_minor IS NOT OLD.pending_minor
   AND EXISTS(SELECT 1 FROM activities WHERE id=OLD.activity_id AND ended_at IS NOT NULL))
 OR (OLD.settled_at IS NULL AND NEW.settled_at IS NOT NULL AND (NEW.settled_minor IS NOT OLD.pending_minor
   OR (NEW.claim_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM claims c
     JOIN reward_inventory r ON r.activity_id=c.activity_id AND r.id=c.inventory_id
     WHERE c.id=NEW.claim_id AND c.activity_id=OLD.activity_id AND c.user_id=OLD.user_id AND r.amount_minor=NEW.settled_minor))))
BEGIN SELECT RAISE(ABORT,'invalid_code_judge_person'); END;
--> statement-breakpoint
-- Everyone's pending together, kept as each one's moves.
CREATE TRIGGER code_judge_people_pending_insert AFTER INSERT ON code_judge_people
WHEN NEW.pending_minor!=0
BEGIN UPDATE activity_code SET pending_minor=pending_minor+NEW.pending_minor WHERE activity_id=NEW.activity_id; END;
--> statement-breakpoint
CREATE TRIGGER code_judge_people_pending_update AFTER UPDATE OF pending_minor ON code_judge_people
WHEN NEW.pending_minor IS NOT OLD.pending_minor
BEGIN UPDATE activity_code SET pending_minor=pending_minor+NEW.pending_minor-OLD.pending_minor
  WHERE activity_id=NEW.activity_id; END;
--> statement-breakpoint
-- A move is a protocol 5 judgment's, the one judged first, written before
-- their pending moves; none changes or goes.
CREATE TRIGGER code_judgment_moves_insert_guard BEFORE INSERT ON code_judgment_moves
WHEN NOT EXISTS(SELECT 1 FROM code_judgments j JOIN activity_code c ON c.activity_id=j.activity_id
   WHERE j.submission_row_id=NEW.submission_row_id AND j.activity_id=NEW.activity_id AND c.protocol>=5
     AND ((NEW.position=0 AND j.user_id=NEW.user_id) OR (NEW.position>0 AND j.user_id!=NEW.user_id)))
 OR NEW.before_minor IS NOT COALESCE((SELECT pending_minor FROM code_judge_people
   WHERE activity_id=NEW.activity_id AND user_id=NEW.user_id AND settled_at IS NULL),
   CASE WHEN NEW.position=0 AND NOT EXISTS(SELECT 1 FROM code_judge_people
     WHERE activity_id=NEW.activity_id AND user_id=NEW.user_id) THEN 0 END)
BEGIN SELECT RAISE(ABORT,'invalid_code_judgment_move'); END;
--> statement-breakpoint
CREATE TRIGGER code_judgment_moves_update_guard BEFORE UPDATE ON code_judgment_moves
BEGIN SELECT RAISE(ABORT,'immutable_code_judgment_move'); END;
--> statement-breakpoint
CREATE TRIGGER code_judgment_moves_delete_guard BEFORE DELETE ON code_judgment_moves
BEGIN SELECT RAISE(ABORT,'immutable_code_judgment_move'); END;
--> statement-breakpoint
-- Drafts open on protocol 5: no shares; at most one claim per 0.01.
UPDATE activities SET total_count = CAST(ROUND(CAST(json_extract(config,'$.money.totalAmount') AS REAL)*100) AS INTEGER),
  version = version + 1
WHERE participation_mode='code' AND opened_at IS NULL AND deleted_at IS NULL
  AND json_extract(config,'$.money.totalAmount') IS NOT NULL;
--> statement-breakpoint
PRAGMA defer_foreign_keys=OFF;
