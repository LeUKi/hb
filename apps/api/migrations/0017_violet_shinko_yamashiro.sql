ALTER TABLE `activities` ADD `post_number` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `activities` ADD `deleted_at` integer;--> statement-breakpoint
CREATE INDEX `activities_reply_opened_idx` ON `activities` (`topic_id`,`post_number`,"opened_at" DESC,"id" DESC) WHERE "activities"."deleted_at" IS NULL AND "activities"."archived_at" IS NULL AND "activities"."opened_at" IS NOT NULL;--> statement-breakpoint
ALTER TABLE `redemption_submissions` ADD `purpose` text DEFAULT 'claim' NOT NULL;--> statement-breakpoint
CREATE INDEX `redemption_submissions_solved_idx` ON `redemption_submissions` (`activity_id`,`user_id`,`purpose`,`outcome`,`matched_password_id`);--> statement-breakpoint
-- Historical reply numbers were discarded by the old parser; the only honest backfill is reply 1.
-- json('true')/json('false') preserve booleans rather than converting them to integer flags.
UPDATE activities SET config = json_set(config,
  '$.topicUrl', CASE WHEN topic_id IS NULL THEN '' ELSE 'https://linux.do/t/' || topic_id || '/1' END,
  '$.quantityVisibility', CASE WHEN json_extract(config,'$.quantityVisibility')='fuzzy' THEN 'fuzzy' ELSE 'exact' END,
  '$.showRecipientUsername', json(CASE WHEN json_extract(config,'$.showRecipientList')=1 THEN 'true' ELSE 'false' END),
  '$.showRecipientTime', json(CASE WHEN json_extract(config,'$.showRecipientList')=1 THEN 'true' ELSE 'false' END),
  '$.showRecipientAmount', json(CASE WHEN json_extract(config,'$.showRecipientList')=1 THEN 'true' ELSE 'false' END)
), version=version+1;
--> statement-breakpoint
CREATE TRIGGER activities_reply_insert_guard BEFORE INSERT ON activities
WHEN typeof(NEW.post_number)!='integer' OR NEW.post_number<1 OR NEW.post_number>9007199254740991
BEGIN SELECT RAISE(ABORT,'invalid_reply_number'); END;
--> statement-breakpoint
CREATE TRIGGER activities_reply_update_guard BEFORE UPDATE OF post_number ON activities
WHEN typeof(NEW.post_number)!='integer' OR NEW.post_number<1 OR NEW.post_number>9007199254740991
BEGIN SELECT RAISE(ABORT,'invalid_reply_number'); END;
--> statement-breakpoint
CREATE TRIGGER activities_deleted_immutable BEFORE UPDATE ON activities
WHEN OLD.deleted_at IS NOT NULL
BEGIN SELECT RAISE(ABORT,'activity_deleted'); END;
--> statement-breakpoint
CREATE TRIGGER activities_delete_guard BEFORE UPDATE OF deleted_at ON activities
WHEN NEW.deleted_at IS NOT NULL AND (OLD.opened_at IS NOT NULL OR NEW.opened_at IS NOT NULL
  OR EXISTS(SELECT 1 FROM claims WHERE activity_id=OLD.id)
  OR EXISTS(SELECT 1 FROM redemption_submissions WHERE activity_id=OLD.id AND matched_password_id IS NOT NULL))
BEGIN SELECT RAISE(ABORT,'activity_not_deletable'); END;
--> statement-breakpoint
CREATE TRIGGER activity_passwords_deleted_guard BEFORE INSERT ON activity_passwords
WHEN EXISTS(SELECT 1 FROM activities WHERE id=NEW.activity_id AND deleted_at IS NOT NULL)
BEGIN SELECT RAISE(ABORT,'activity_deleted'); END;
--> statement-breakpoint
CREATE TRIGGER reward_inventory_deleted_guard BEFORE INSERT ON reward_inventory
WHEN EXISTS(SELECT 1 FROM activities WHERE id=NEW.activity_id AND deleted_at IS NOT NULL)
BEGIN SELECT RAISE(ABORT,'activity_deleted'); END;
--> statement-breakpoint
CREATE TRIGGER claims_deleted_guard BEFORE INSERT ON claims
WHEN EXISTS(SELECT 1 FROM activities WHERE id=NEW.activity_id AND deleted_at IS NOT NULL)
BEGIN SELECT RAISE(ABORT,'activity_deleted'); END;
--> statement-breakpoint
CREATE TRIGGER redemption_submissions_purpose_insert_guard BEFORE INSERT ON redemption_submissions
WHEN NEW.purpose NOT IN ('claim','solve')
 OR (NEW.purpose='solve' AND (NEW.outcome NOT IN ('solved','incorrect','ended','archived') OR NEW.claim_id IS NOT NULL OR NEW.finished_at IS NULL))
 OR (NEW.outcome='solved' AND (NEW.purpose!='solve' OR NEW.matched_password_id IS NULL))
 OR EXISTS(SELECT 1 FROM activities WHERE id=NEW.activity_id AND deleted_at IS NOT NULL)
BEGIN SELECT RAISE(ABORT,'invalid_submission_purpose'); END;
--> statement-breakpoint
CREATE TRIGGER redemption_submissions_purpose_update_guard BEFORE UPDATE ON redemption_submissions
WHEN NEW.purpose IS NOT OLD.purpose
 OR (NEW.purpose='solve' AND (NEW.outcome IS NOT OLD.outcome OR NEW.matched_password_id IS NOT OLD.matched_password_id OR NEW.claim_id IS NOT NULL))
 OR (NEW.outcome='solved' AND NEW.purpose!='solve')
BEGIN SELECT RAISE(ABORT,'immutable_submission_purpose'); END;
