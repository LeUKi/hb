-- 新版本先由作者发红包 (docs/judge-square-design.md §17, 2026-11-01): a
-- version can be withdrawn — only the newest that passed, with none
-- withdrawn after it (one step back at most), before it opened a 红包 or
-- was chosen for 站长精选. A withdrawn version stays as it is, opens no 红包
-- and is chosen for nothing after.
ALTER TABLE `judge_versions` ADD `withdrawn_at` integer;
--> statement-breakpoint
DROP TRIGGER judge_versions_update_guard;
--> statement-breakpoint
CREATE TRIGGER judge_versions_update_guard BEFORE UPDATE ON judge_versions
WHEN NEW.judge_id IS NOT OLD.judge_id OR NEW.n IS NOT OLD.n OR NEW.fingerprint IS NOT OLD.fingerprint
 OR NEW.code_ciphertext IS NOT OLD.code_ciphertext OR NEW.deployed_at IS NOT OLD.deployed_at
 OR NEW.checked_at < OLD.checked_at
 OR (NEW.passed=1 AND NOT EXISTS(SELECT 1 FROM judge_checks k JOIN judges j ON j.id=NEW.judge_id
   WHERE k.user_id=j.author_id AND k.protocol=NEW.protocol AND k.fingerprint=NEW.fingerprint
     AND k.tests_digest=NEW.tests_digest AND k.passed=1))
 OR OLD.withdrawn_at IS NOT NULL
 OR (NEW.withdrawn_at IS NOT NULL AND (typeof(NEW.withdrawn_at)!='integer' OR OLD.passed!=1
   OR NEW.passed IS NOT OLD.passed OR NEW.protocol IS NOT OLD.protocol OR NEW.tests_digest IS NOT OLD.tests_digest
   OR EXISTS(SELECT 1 FROM judge_versions w WHERE w.judge_id=NEW.judge_id AND w.n>NEW.n
     AND (w.passed=1 OR w.withdrawn_at IS NOT NULL))
   OR EXISTS(SELECT 1 FROM activity_code c JOIN activities a ON a.id=c.activity_id
     WHERE c.judge_id=NEW.judge_id AND c.judge_version=NEW.n AND a.opened_at IS NOT NULL)
   OR EXISTS(SELECT 1 FROM judge_features f WHERE f.judge_id=NEW.judge_id AND f.n=NEW.n)))
BEGIN SELECT RAISE(ABORT,'immutable_judge_version'); END;
--> statement-breakpoint
DROP TRIGGER judge_features_insert_guard;
--> statement-breakpoint
CREATE TRIGGER judge_features_insert_guard BEFORE INSERT ON judge_features
WHEN typeof(NEW.position)!='integer' OR NEW.position<0 OR typeof(NEW.created_at)!='integer'
 OR NEW.updated_at!=NEW.created_at
 OR NOT EXISTS(SELECT 1 FROM judge_versions v JOIN judges j ON j.id=v.judge_id
   WHERE v.judge_id=NEW.judge_id AND v.n=NEW.n AND v.passed=1 AND v.protocol>=3 AND v.withdrawn_at IS NULL
     AND (j.featurable=1 OR j.author_id=NEW.created_by))
BEGIN SELECT RAISE(ABORT,'invalid_judge_feature'); END;
--> statement-breakpoint
DROP TRIGGER judge_features_update_guard;
--> statement-breakpoint
CREATE TRIGGER judge_features_update_guard BEFORE UPDATE ON judge_features
WHEN NEW.judge_id IS NOT OLD.judge_id OR NEW.created_by IS NOT OLD.created_by OR NEW.created_at IS NOT OLD.created_at
 OR typeof(NEW.position)!='integer' OR NEW.position<0 OR NEW.updated_at<OLD.updated_at
 OR (NEW.n IS NOT OLD.n AND NOT EXISTS(SELECT 1 FROM judge_versions v
   WHERE v.judge_id=NEW.judge_id AND v.n=NEW.n AND v.passed=1 AND v.protocol>=3 AND v.withdrawn_at IS NULL))
BEGIN SELECT RAISE(ABORT,'invalid_judge_feature'); END;
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
     WHERE c.activity_id=NEW.id AND j.taken_down_at IS NOT NULL)
   OR EXISTS(SELECT 1 FROM activity_code c JOIN judge_versions v ON v.judge_id=c.judge_id AND v.n=c.judge_version
     WHERE c.activity_id=NEW.id AND v.withdrawn_at IS NOT NULL))))
BEGIN SELECT RAISE(ABORT,'invalid_participation_passwords'); END;
