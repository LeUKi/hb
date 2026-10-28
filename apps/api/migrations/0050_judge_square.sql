-- 判定器广场 (docs/judge-square-design.md §8, §9, §15, 2026-10-28): a
-- 判定器 joins the 广场 (its code public for good) and may be chosen for
-- 精选; the 站长 takes one down, with a reason its author reads, and may
-- restore it. Its numbers are worked out by the maintenance task. A 红包
-- may use another's 判定器 while it is in the 广场 (a draft that has it
-- keeps it, its upsert passing the insert guard too); it opens with the
-- run that passed for that 判定器's author, and not once the 站长 took it
-- down.
CREATE TABLE `judge_features` (
	`judge_id` text PRIMARY KEY NOT NULL,
	`n` integer NOT NULL,
	`position` integer NOT NULL,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`judge_id`) REFERENCES `judges`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `judge_features_position_idx` ON `judge_features` (`position`);--> statement-breakpoint
CREATE TABLE `judge_square_changes` (
	`id` text PRIMARY KEY NOT NULL,
	`actor_user_id` text NOT NULL,
	`judge_id` text NOT NULL,
	`action` text NOT NULL,
	`name` text NOT NULL,
	`reason` text,
	`n` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`actor_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`judge_id`) REFERENCES `judges`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `judge_square_changes_time_idx` ON `judge_square_changes` (`created_at`);--> statement-breakpoint
CREATE TABLE `judge_stats` (
	`judge_id` text PRIMARY KEY NOT NULL,
	`hongbao` integer NOT NULL,
	`judged` integer NOT NULL,
	`claimed` integer NOT NULL,
	`last_opened_at` integer,
	`public_n` integer,
	`refreshed_at` integer NOT NULL,
	FOREIGN KEY (`judge_id`) REFERENCES `judges`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `judge_stats_used_idx` ON `judge_stats` (`hongbao`,`last_opened_at`);--> statement-breakpoint
CREATE INDEX `judge_stats_recent_idx` ON `judge_stats` (`last_opened_at`);--> statement-breakpoint
ALTER TABLE `activity_code` ADD `network_ack` text;--> statement-breakpoint
CREATE INDEX `activity_code_judge_idx` ON `activity_code` (`judge_id`,`judge_version`);--> statement-breakpoint
ALTER TABLE `judges` ADD `listed_at` integer;--> statement-breakpoint
ALTER TABLE `judges` ADD `featurable` integer DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE `judges` ADD `taken_down_at` integer;--> statement-breakpoint
ALTER TABLE `judges` ADD `taken_down_reason` text;--> statement-breakpoint
ALTER TABLE `judges` ADD `taken_down_by` text REFERENCES users(id);
--> statement-breakpoint
DROP TRIGGER activity_code_insert_guard;
--> statement-breakpoint
CREATE TRIGGER activity_code_insert_guard BEFORE INSERT ON activity_code
WHEN NOT EXISTS(SELECT 1 FROM activities WHERE id=NEW.activity_id AND participation_mode='code'
   AND opened_at IS NULL AND deleted_at IS NULL)
 OR NEW.seed_commitment IS NOT NULL OR NEW.state_ciphertext IS NOT NULL OR NEW.failures_in_row!=0
 OR NEW.sandbox!=0 OR NEW.paused_at IS NOT NULL OR NEW.stopped_at IS NOT NULL OR NEW.revealed_at IS NOT NULL
 OR NEW.network IS NOT NULL OR NEW.params_public IS NOT NULL OR NEW.params_commitment IS NOT NULL
 OR NEW.params_secret IS NOT NULL
 OR (NEW.judge_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM judges j JOIN activities a ON a.id=NEW.activity_id
   WHERE j.id=NEW.judge_id AND (j.author_id=a.author_id OR (j.listed_at IS NOT NULL AND j.taken_down_at IS NULL)
     OR EXISTS(SELECT 1 FROM activity_code k WHERE k.activity_id=NEW.activity_id AND k.judge_id=NEW.judge_id))))
 OR (NEW.judge_version IS NOT NULL AND NOT EXISTS(SELECT 1 FROM judge_versions v
   WHERE v.judge_id=NEW.judge_id AND v.n=NEW.judge_version AND v.fingerprint=NEW.fingerprint))
BEGIN SELECT RAISE(ABORT,'invalid_activity_code'); END;
--> statement-breakpoint
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
      WHERE j.id=NEW.judge_id AND (j.author_id=a.author_id OR (j.listed_at IS NOT NULL AND j.taken_down_at IS NULL))))
    OR (NEW.judge_version IS NOT NULL AND NOT EXISTS(SELECT 1 FROM judge_versions v
      WHERE v.judge_id=NEW.judge_id AND v.n=NEW.judge_version AND v.fingerprint=NEW.fingerprint))))
 OR (OLD.revealed_at IS NULL AND NEW.revealed_at IS NOT NULL AND NOT EXISTS(SELECT 1 FROM activities a
   WHERE a.id=OLD.activity_id AND a.opened_at IS NOT NULL AND (a.ended_at IS NOT NULL OR a.claimed_count>=a.total_count
     OR a.deadline<=CAST((julianday('now')-2440587.5)*86400000 AS INTEGER))))
BEGIN SELECT RAISE(ABORT,'immutable_activity_code'); END;
--> statement-breakpoint
DROP TRIGGER activities_participation_open_guard;
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
-- In the 广场 only with its code public and not taken down; a reason
-- with every 撤下, and only then. Made outside it.
CREATE TRIGGER judges_insert_guard BEFORE INSERT ON judges
WHEN NEW.listed_at IS NOT NULL OR NEW.taken_down_at IS NOT NULL OR NEW.taken_down_reason IS NOT NULL
 OR NEW.taken_down_by IS NOT NULL OR NEW.featurable NOT IN (0,1)
BEGIN SELECT RAISE(ABORT,'invalid_judge'); END;
--> statement-breakpoint
DROP TRIGGER judges_update_guard;
--> statement-breakpoint
CREATE TRIGGER judges_update_guard BEFORE UPDATE ON judges
WHEN NEW.id IS NOT OLD.id OR NEW.author_id IS NOT OLD.author_id OR NEW.created_at IS NOT OLD.created_at
 OR NEW.based_on_judge_id IS NOT OLD.based_on_judge_id OR NEW.updated_at < OLD.updated_at
 OR (OLD.code_public='always' AND NEW.code_public IS NOT 'always')
 OR NEW.featurable NOT IN (0,1)
 OR (NEW.listed_at IS NOT NULL AND (typeof(NEW.listed_at)!='integer' OR NEW.code_public IS NOT 'always'
   OR NEW.taken_down_at IS NOT NULL))
 OR ((NEW.taken_down_at IS NULL) != (NEW.taken_down_reason IS NULL)
   OR (NEW.taken_down_at IS NULL) != (NEW.taken_down_by IS NULL))
 OR (NEW.taken_down_reason IS NOT NULL AND (length(NEW.taken_down_reason) NOT BETWEEN 1 AND 100
   OR NEW.taken_down_reason != trim(NEW.taken_down_reason) OR typeof(NEW.taken_down_at)!='integer'))
BEGIN SELECT RAISE(ABORT,'immutable_judge'); END;
--> statement-breakpoint
-- 精选 (§9): a version that passed on protocol 3, of one its author let
-- the 站长 choose (or the 站长's own); its place a whole number.
CREATE TRIGGER judge_features_insert_guard BEFORE INSERT ON judge_features
WHEN typeof(NEW.position)!='integer' OR NEW.position<0 OR typeof(NEW.created_at)!='integer'
 OR NEW.updated_at!=NEW.created_at
 OR NOT EXISTS(SELECT 1 FROM judge_versions v JOIN judges j ON j.id=v.judge_id
   WHERE v.judge_id=NEW.judge_id AND v.n=NEW.n AND v.passed=1 AND v.protocol=3
     AND (j.featurable=1 OR j.author_id=NEW.created_by))
BEGIN SELECT RAISE(ABORT,'invalid_judge_feature'); END;
--> statement-breakpoint
CREATE TRIGGER judge_features_update_guard BEFORE UPDATE ON judge_features
WHEN NEW.judge_id IS NOT OLD.judge_id OR NEW.created_by IS NOT OLD.created_by OR NEW.created_at IS NOT OLD.created_at
 OR typeof(NEW.position)!='integer' OR NEW.position<0 OR NEW.updated_at<OLD.updated_at
 OR (NEW.n IS NOT OLD.n AND NOT EXISTS(SELECT 1 FROM judge_versions v
   WHERE v.judge_id=NEW.judge_id AND v.n=NEW.n AND v.passed=1 AND v.protocol=3))
BEGIN SELECT RAISE(ABORT,'invalid_judge_feature'); END;
--> statement-breakpoint
-- What the 站长 did to the 广场 stays as written.
CREATE TRIGGER judge_square_changes_insert_guard BEFORE INSERT ON judge_square_changes
WHEN NEW.action NOT IN ('take_down','restore','feature','unfeature','move','version')
 OR (NEW.action='take_down' AND (NEW.reason IS NULL OR length(NEW.reason) NOT BETWEEN 1 AND 100))
 OR (NEW.action!='take_down' AND NEW.reason IS NOT NULL)
 OR (NEW.action IN ('feature','version') AND NEW.n IS NULL)
 OR typeof(NEW.created_at)!='integer'
BEGIN SELECT RAISE(ABORT,'invalid_judge_square_change'); END;
--> statement-breakpoint
CREATE TRIGGER judge_square_changes_update_guard BEFORE UPDATE ON judge_square_changes
BEGIN SELECT RAISE(ABORT,'immutable_judge_square_change'); END;
--> statement-breakpoint
CREATE TRIGGER judge_square_changes_delete_guard BEFORE DELETE ON judge_square_changes
BEGIN SELECT RAISE(ABORT,'immutable_judge_square_change'); END;
