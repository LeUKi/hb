-- 填表试算 (docs/judge-square-design.md §3.3): check() and explain() run as a
-- sender fills the form are counted in their own column, apart from the
-- sender's runs a day (tries). A new column with a default; the update guard
-- learns that it only grows. No data changes.
ALTER TABLE `judge_usage` ADD `fills` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
DROP TRIGGER judge_usage_update_guard;--> statement-breakpoint
CREATE TRIGGER judge_usage_update_guard BEFORE UPDATE ON judge_usage
WHEN NEW.day IS NOT OLD.day OR NEW.sandbox_id IS NOT OLD.sandbox_id OR NEW.fingerprint IS NOT OLD.fingerprint
 OR NEW.protocol IS NOT OLD.protocol OR NEW.networked IS NOT OLD.networked
 OR NEW.fresh IS NOT OLD.fresh OR NEW.user_id IS NOT OLD.user_id OR NEW.first_at IS NOT OLD.first_at
 OR (OLD.activity_id IS NOT NULL AND NEW.activity_id IS NOT OLD.activity_id)
 OR (OLD.activity_id IS NULL AND NEW.activity_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM activities a
   JOIN activity_code c ON c.activity_id=a.id
   WHERE a.id=NEW.activity_id AND a.participation_mode='code' AND a.opened_at IS NOT NULL AND c.fingerprint=NEW.fingerprint))
 OR NEW.deploys<OLD.deploys OR NEW.reruns<OLD.reruns OR NEW.claims<OLD.claims OR NEW.timeouts<OLD.timeouts
 OR NEW.switches<OLD.switches OR NEW.fetches<OLD.fetches OR NEW.tries<OLD.tries OR NEW.fills<OLD.fills
 OR typeof(NEW.fills)<>'integer' OR NEW.last_at<OLD.last_at
BEGIN SELECT RAISE(ABORT,'invalid_judge_usage'); END;
