CREATE TABLE `activity_code` (
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
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`activity_id`) REFERENCES `activities`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`stopped_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "activity_code_shape" CHECK("activity_code"."protocol" = 1 AND length("activity_code"."fingerprint") = 64 AND length("activity_code"."tests_digest") = 64
        AND length("activity_code"."prompt") <= 40
        AND typeof("activity_code"."min_each_minor") = 'integer' AND "activity_code"."min_each_minor" > 0
        AND ("activity_code"."seed_commitment" IS NULL) = ("activity_code"."seed_ciphertext" IS NULL)
        AND ("activity_code"."seed_commitment" IS NULL OR length("activity_code"."seed_commitment") = 64)
        AND typeof("activity_code"."failures_in_row") = 'integer' AND "activity_code"."failures_in_row" BETWEEN 0 AND 5
        AND typeof("activity_code"."sandbox") = 'integer' AND "activity_code"."sandbox" BETWEEN 0 AND 3
        AND ("activity_code"."stopped_at" IS NULL) = ("activity_code"."stopped_by_user_id" IS NULL)
        AND ("activity_code"."code" IS NULL) = ("activity_code"."revealed_at" IS NULL)
        AND ("activity_code"."seed" IS NULL) = ("activity_code"."revealed_at" IS NULL)
        AND ("activity_code"."seed" IS NULL OR length("activity_code"."seed") = 64))
);
--> statement-breakpoint
CREATE TABLE `code_failures` (
	`id` text PRIMARY KEY NOT NULL,
	`activity_id` text NOT NULL,
	`user_id` text NOT NULL,
	`kind` text NOT NULL,
	`detail` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`activity_id`) REFERENCES `activities`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `code_failures_activity_time_idx` ON `code_failures` (`activity_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `code_judgments` (
	`submission_row_id` text PRIMARY KEY NOT NULL,
	`activity_id` text NOT NULL,
	`user_id` text NOT NULL,
	`sequence` integer NOT NULL,
	`attempt` integer NOT NULL,
	`title` text NOT NULL,
	`username` text NOT NULL,
	`level` integer,
	`ok` integer NOT NULL,
	`asked_minor` integer,
	`paid_minor` integer,
	`note` text,
	`message` text,
	`state_ciphertext` text,
	`judged_at` integer NOT NULL,
	FOREIGN KEY (`submission_row_id`) REFERENCES `redemption_submissions`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`activity_id`) REFERENCES `activities`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "code_judgments_shape" CHECK(typeof("code_judgments"."attempt") = 'integer' AND "code_judgments"."attempt" >= 0
        AND typeof("code_judgments"."sequence") = 'integer' AND "code_judgments"."sequence" >= 0
        AND ("code_judgments"."level" IS NULL OR (typeof("code_judgments"."level") = 'integer' AND "code_judgments"."level" BETWEEN 0 AND 4))
        AND ("code_judgments"."message" IS NULL OR length("code_judgments"."message") BETWEEN 1 AND 100)
        AND (("code_judgments"."ok" = 1 AND typeof("code_judgments"."asked_minor") = 'integer'
            AND typeof("code_judgments"."paid_minor") = 'integer' AND "code_judgments"."paid_minor" > 0
            AND ("code_judgments"."note" IS NULL OR "code_judgments"."note" IN ('floor','cap','last')))
          OR ("code_judgments"."ok" = 0 AND "code_judgments"."asked_minor" IS NULL AND "code_judgments"."paid_minor" IS NULL AND "code_judgments"."note" IS NULL)))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `code_judgments_attempt_unique` ON `code_judgments` (`activity_id`,`user_id`,`attempt`);--> statement-breakpoint
CREATE UNIQUE INDEX `code_judgments_sequence_unique` ON `code_judgments` (`activity_id`,`sequence`);--> statement-breakpoint
CREATE TABLE `judge_checks` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`protocol` integer NOT NULL,
	`fingerprint` text NOT NULL,
	`tests_digest` text NOT NULL,
	`passed` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `judge_checks_user_time_idx` ON `judge_checks` (`user_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `judge_checks_user_code_idx` ON `judge_checks` (`user_id`,`fingerprint`,`tests_digest`);--> statement-breakpoint
ALTER TABLE `balance_settings` ADD `code_hongbao_enabled` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `balance_settings` ADD `code_hongbao_daily_limit` integer DEFAULT 3 NOT NULL;--> statement-breakpoint
ALTER TABLE `balance_settings` ADD `code_check_daily_limit` integer DEFAULT 10 NOT NULL;
--> statement-breakpoint
-- 代码判定红包 (docs/programmable-hongbao-design.md): a third way to take
-- part. Only from 🐟额, only on its page (so on 红包广场), shares made one
-- at a time as the code judges them, never with 口令.
DROP TRIGGER activities_participation_insert_guard;
--> statement-breakpoint
CREATE TRIGGER activities_participation_insert_guard BEFORE INSERT ON activities
WHEN NEW.participation_mode NOT IN ('password','direct','code')
 OR (NEW.deleted_at IS NULL AND COALESCE(json_extract(NEW.config,'$.participationMode'),'password') IS NOT NEW.participation_mode)
 OR (NEW.participation_mode='direct' AND NEW.force_dedicated!=0)
 OR (NEW.deleted_at IS NULL AND (NEW.participation_mode='code') != (COALESCE(json_extract(NEW.config,'$.money.mode'),'')='code'))
 OR (NEW.participation_mode='code' AND (NEW.force_dedicated!=1 OR NEW.join_square!=1 OR NEW.funding!='balance'
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
 OR (NEW.participation_mode='code' AND (NEW.force_dedicated!=1 OR NEW.join_square!=1 OR NEW.funding!='balance'
   OR NEW.allocation!='sequential' OR NEW.draw_state IS NOT NULL))
BEGIN SELECT RAISE(ABORT,'invalid_participation_mode'); END;
--> statement-breakpoint
-- It opens with its seed sealed, and only with the code and tests its
-- sender checked online (在线检查) that passed.
DROP TRIGGER activities_participation_open_guard;
--> statement-breakpoint
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
DROP TRIGGER activity_passwords_participation_guard;
--> statement-breakpoint
CREATE TRIGGER activity_passwords_participation_guard BEFORE INSERT ON activity_passwords
WHEN EXISTS(SELECT 1 FROM activities WHERE id=NEW.activity_id AND participation_mode IN ('direct','code'))
BEGIN SELECT RAISE(ABORT,'direct_activity_has_no_passwords'); END;
--> statement-breakpoint
DROP TRIGGER activity_passwords_participation_update_guard;
--> statement-breakpoint
CREATE TRIGGER activity_passwords_participation_update_guard BEFORE UPDATE OF activity_id ON activity_passwords
WHEN EXISTS(SELECT 1 FROM activities WHERE id=NEW.activity_id AND participation_mode IN ('direct','code'))
BEGIN SELECT RAISE(ABORT,'direct_activity_has_no_passwords'); END;
--> statement-breakpoint
-- A code-judged claim takes the share its own judgment paid.
DROP TRIGGER claims_participation_insert_guard;
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
     AND j.ok=1 AND j.paid_minor=r.amount_minor))))
BEGIN SELECT RAISE(ABORT,'invalid_claim_participation'); END;
--> statement-breakpoint
-- A code-judged submission is a claim: judged (pending, then claimed) or
-- turned down (incorrect), after its attempt interval like any other.
DROP TRIGGER redemption_submissions_mode_insert_guard;
--> statement-breakpoint
CREATE TRIGGER redemption_submissions_mode_insert_guard BEFORE INSERT ON redemption_submissions
WHEN NEW.participation_mode NOT IN ('password','direct','code')
 OR NOT EXISTS(SELECT 1 FROM activities WHERE id=NEW.activity_id AND participation_mode=NEW.participation_mode)
 OR (NEW.participation_mode='direct' AND (NEW.purpose NOT IN ('claim','register') OR NEW.matched_password_id IS NOT NULL OR NEW.outcome IN ('incorrect','solved')))
 OR (NEW.participation_mode='direct' AND NEW.outcome='pending' AND NOT EXISTS(SELECT 1 FROM account_attempt_cooldowns c WHERE c.user_id=NEW.user_id AND c.attempt_id=NEW.id AND c.origin='activity'))
 OR (NEW.participation_mode='code' AND (NEW.purpose!='claim' OR NEW.matched_password_id IS NOT NULL OR NEW.outcome IN ('solved','registered','already_registered')))
 OR (NEW.participation_mode='code' AND NEW.outcome IN ('pending','incorrect') AND (NEW.validated_at IS NULL
   OR NOT EXISTS(SELECT 1 FROM account_attempt_cooldowns c WHERE c.user_id=NEW.user_id AND c.attempt_id=NEW.id AND c.origin='activity')))
 OR (NEW.matched_password_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM activity_passwords WHERE id=NEW.matched_password_id AND activity_id=NEW.activity_id))
BEGIN SELECT RAISE(ABORT,'invalid_submission_participation'); END;
--> statement-breakpoint
DROP TRIGGER redemption_submissions_mode_update_guard;
--> statement-breakpoint
CREATE TRIGGER redemption_submissions_mode_update_guard BEFORE UPDATE ON redemption_submissions
WHEN NEW.participation_mode IS NOT OLD.participation_mode
 OR (NEW.participation_mode='direct' AND (NEW.purpose NOT IN ('claim','register') OR NEW.matched_password_id IS NOT NULL OR NEW.outcome IN ('incorrect','solved')))
 OR (NEW.participation_mode='code' AND (NEW.purpose!='claim' OR NEW.matched_password_id IS NOT NULL
   OR NEW.outcome IN ('solved','registered','already_registered')
   OR (OLD.outcome='pending' AND NEW.outcome='incorrect')
   OR (OLD.outcome!='pending' AND NEW.outcome IS NOT OLD.outcome)))
BEGIN SELECT RAISE(ABORT,'immutable_submission_participation'); END;
--> statement-breakpoint
-- A code-judged 红包 has no shares until each is judged: each is made at
-- its claim, next in line, within its range (第 2 节) against the lock,
-- and never changed after.
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
CREATE TRIGGER reward_inventory_code_update_guard BEFORE UPDATE ON reward_inventory
WHEN EXISTS(SELECT 1 FROM activities WHERE id=OLD.activity_id AND participation_mode='code' AND opened_at IS NOT NULL)
BEGIN SELECT RAISE(ABORT,'immutable_code_share'); END;
--> statement-breakpoint
CREATE TRIGGER reward_inventory_code_delete_guard BEFORE DELETE ON reward_inventory
WHEN EXISTS(SELECT 1 FROM activities WHERE id=OLD.activity_id AND participation_mode='code' AND opened_at IS NOT NULL)
BEGIN SELECT RAISE(ABORT,'immutable_code_share'); END;
--> statement-breakpoint
-- Its code: changed freely as a draft; from opening the code, the tests,
-- the prompt, 每份至少 and the sealed seed stay as they were. The code and
-- the seed come out once, when it is over; 停用 is once too.
CREATE TRIGGER activity_code_insert_guard BEFORE INSERT ON activity_code
WHEN NOT EXISTS(SELECT 1 FROM activities WHERE id=NEW.activity_id AND participation_mode='code'
   AND opened_at IS NULL AND deleted_at IS NULL)
 OR NEW.seed_commitment IS NOT NULL OR NEW.state_ciphertext IS NOT NULL OR NEW.failures_in_row!=0
 OR NEW.sandbox!=0 OR NEW.paused_at IS NOT NULL OR NEW.stopped_at IS NOT NULL OR NEW.revealed_at IS NOT NULL
BEGIN SELECT RAISE(ABORT,'invalid_activity_code'); END;
--> statement-breakpoint
CREATE TRIGGER activity_code_update_guard BEFORE UPDATE ON activity_code
WHEN NEW.activity_id IS NOT OLD.activity_id OR NEW.created_at IS NOT OLD.created_at
 OR (OLD.seed_commitment IS NOT NULL AND (NEW.seed_commitment IS NOT OLD.seed_commitment
   OR NEW.seed_ciphertext IS NOT OLD.seed_ciphertext))
 OR (EXISTS(SELECT 1 FROM activities WHERE id=OLD.activity_id AND opened_at IS NOT NULL) AND (
   NEW.protocol IS NOT OLD.protocol OR NEW.prompt IS NOT OLD.prompt OR NEW.fingerprint IS NOT OLD.fingerprint
   OR NEW.code_ciphertext IS NOT OLD.code_ciphertext OR NEW.tests_ciphertext IS NOT OLD.tests_ciphertext
   OR NEW.tests_digest IS NOT OLD.tests_digest OR NEW.min_each_minor IS NOT OLD.min_each_minor))
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
-- A judgment belongs to its submission (pending when paid, incorrect when
-- turned down), counts this 红包's and this person's judgments in order,
-- and is kept as it was.
CREATE TRIGGER code_judgments_insert_guard BEFORE INSERT ON code_judgments
WHEN NOT EXISTS(SELECT 1 FROM redemption_submissions s JOIN activities a ON a.id=s.activity_id
   JOIN activity_code c ON c.activity_id=a.id
   WHERE s.id=NEW.submission_row_id AND s.activity_id=NEW.activity_id AND s.user_id=NEW.user_id
     AND s.participation_mode='code' AND s.purpose='claim' AND s.validated_at IS NOT NULL
     AND s.outcome=CASE WHEN NEW.ok=1 THEN 'pending' ELSE 'incorrect' END
     AND a.opened_at IS NOT NULL AND a.ended_at IS NULL AND c.paused_at IS NULL AND c.stopped_at IS NULL)
 OR NEW.attempt IS NOT (SELECT COUNT(*) FROM code_judgments WHERE activity_id=NEW.activity_id AND user_id=NEW.user_id)
 OR NEW.sequence IS NOT (SELECT COUNT(*) FROM code_judgments WHERE activity_id=NEW.activity_id)
BEGIN SELECT RAISE(ABORT,'invalid_code_judgment'); END;
--> statement-breakpoint
CREATE TRIGGER code_judgments_immutable BEFORE UPDATE ON code_judgments
BEGIN SELECT RAISE(ABORT,'immutable_code_judgment'); END;
--> statement-breakpoint
CREATE TRIGGER code_judgments_no_delete BEFORE DELETE ON code_judgments
BEGIN SELECT RAISE(ABORT,'immutable_code_judgment'); END;
--> statement-breakpoint
CREATE TRIGGER code_failures_insert_guard BEFORE INSERT ON code_failures
WHEN NEW.kind NOT IN ('threw','timeout','invalid','memory') OR length(NEW.detail)>500
 OR NOT EXISTS(SELECT 1 FROM activities WHERE id=NEW.activity_id AND participation_mode='code' AND opened_at IS NOT NULL)
BEGIN SELECT RAISE(ABORT,'invalid_code_failure'); END;
--> statement-breakpoint
CREATE TRIGGER code_failures_immutable BEFORE UPDATE ON code_failures
BEGIN SELECT RAISE(ABORT,'immutable_code_failure'); END;
--> statement-breakpoint
CREATE TRIGGER code_failures_no_delete BEFORE DELETE ON code_failures
BEGIN SELECT RAISE(ABORT,'immutable_code_failure'); END;
--> statement-breakpoint
CREATE TRIGGER judge_checks_insert_guard BEFORE INSERT ON judge_checks
WHEN NEW.protocol!=1 OR length(NEW.fingerprint)!=64 OR length(NEW.tests_digest)!=64 OR NEW.passed NOT IN (0,1)
BEGIN SELECT RAISE(ABORT,'invalid_judge_check'); END;
--> statement-breakpoint
CREATE TRIGGER judge_checks_immutable BEFORE UPDATE ON judge_checks
BEGIN SELECT RAISE(ABORT,'immutable_judge_check'); END;
--> statement-breakpoint
CREATE TRIGGER judge_checks_no_delete BEFORE DELETE ON judge_checks
BEGIN SELECT RAISE(ABORT,'immutable_judge_check'); END;
--> statement-breakpoint
CREATE TRIGGER balance_settings_code_limits_valid BEFORE UPDATE ON balance_settings
WHEN NEW.code_hongbao_enabled NOT IN (0,1)
 OR typeof(NEW.code_hongbao_daily_limit)!='integer' OR NEW.code_hongbao_daily_limit NOT BETWEEN 1 AND 1000
 OR typeof(NEW.code_check_daily_limit)!='integer' OR NEW.code_check_daily_limit NOT BETWEEN 1 AND 1000
BEGIN SELECT RAISE(ABORT,'invalid_code_limits'); END;
