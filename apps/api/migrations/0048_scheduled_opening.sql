-- 定时开放 (docs/scheduled-opening-design.md, 2026-10-28): a draft carries
-- its opening time until its ActivityDO opens it; a 🐟额红包 locks its 🐟
-- when timed, gives it back when the timing is taken back or fails, and may
-- lock again when timed again (one active lock at a time).
DROP INDEX `balance_locks_activity_unique`;--> statement-breakpoint
CREATE UNIQUE INDEX `balance_locks_activity_unique` ON `balance_locks` (`activity_id`) WHERE "balance_locks"."status" = 'active';--> statement-breakpoint
ALTER TABLE `activities` ADD `scheduled_open_at` integer;--> statement-breakpoint
ALTER TABLE `activities` ADD `schedule_failed_at` integer;--> statement-breakpoint
ALTER TABLE `activities` ADD `schedule_failure` text;--> statement-breakpoint
CREATE INDEX `activities_scheduled_idx` ON `activities` (`scheduled_open_at`,`id`) WHERE "activities"."scheduled_open_at" IS NOT NULL;
--> statement-breakpoint
-- Only a draft is timed, and it never opens still timed.
CREATE TRIGGER activities_schedule_insert_guard BEFORE INSERT ON activities
WHEN NEW.scheduled_open_at IS NOT NULL
BEGIN SELECT RAISE(ABORT,'new_activity_scheduled'); END;
--> statement-breakpoint
CREATE TRIGGER activities_schedule_update_guard BEFORE UPDATE OF scheduled_open_at, opened_at, deleted_at ON activities
WHEN NEW.scheduled_open_at IS NOT NULL AND (NEW.opened_at IS NOT NULL OR NEW.deleted_at IS NOT NULL
  OR typeof(NEW.scheduled_open_at)!='integer' OR NEW.reward_type!='ldc')
BEGIN SELECT RAISE(ABORT,'invalid_activity_schedule'); END;
--> statement-breakpoint
-- A draft holding 🐟 is not deleted: its timing is taken back first.
CREATE TRIGGER activities_locked_draft_delete_guard BEFORE UPDATE OF deleted_at ON activities
WHEN NEW.deleted_at IS NOT NULL AND EXISTS(SELECT 1 FROM balance_locks l
  WHERE l.activity_id=NEW.id AND l.purpose='activity' AND l.status='active')
BEGIN SELECT RAISE(ABORT,'activity_holds_balance'); END;
--> statement-breakpoint
-- A 🐟额红包 holds its author's 🐟 from when it opens, or from when it is
-- timed: one active lock, theirs.
DROP TRIGGER balance_locks_activity_valid;
--> statement-breakpoint
CREATE TRIGGER balance_locks_activity_valid
BEFORE INSERT ON balance_locks
WHEN NEW.purpose='activity' AND NOT EXISTS (
  SELECT 1 FROM activities a WHERE a.id=NEW.activity_id AND a.funding='balance' AND a.author_id=NEW.user_id
    AND ((a.opened_at IS NOT NULL AND a.ended_at IS NULL)
      OR (a.opened_at IS NULL AND a.scheduled_open_at IS NOT NULL AND a.deleted_at IS NULL)))
BEGIN
  SELECT RAISE(ABORT, 'activity lock needs its open balance hongbao');
END;
--> statement-breakpoint
-- As 0042's, and a lock gives back too once its draft is no longer timed.
DROP TRIGGER balance_entries_lock_guard;
--> statement-breakpoint
CREATE TRIGGER balance_entries_lock_guard
BEFORE INSERT ON balance_entries
WHEN NEW.kind IN ('lock','unlock','deduct') AND NOT EXISTS (
  SELECT 1 FROM balance_locks l WHERE l.id=NEW.lock_id AND l.user_id=NEW.user_id AND l.status='active'
    AND ((NEW.kind='lock' AND l.remaining_minor=l.amount_minor AND NEW.locked_delta_minor=l.amount_minor)
      OR (NEW.kind='unlock' AND -NEW.locked_delta_minor=l.remaining_minor
        AND (l.purpose='withdrawal' OR EXISTS (SELECT 1 FROM activities a WHERE a.id=l.activity_id
          AND ((a.ended_at IS NOT NULL AND (a.draw_state IS NULL OR a.draw_state IN ('completed','empty')))
            OR (a.opened_at IS NULL AND a.scheduled_open_at IS NULL)))))
      OR (NEW.kind='deduct' AND -NEW.locked_delta_minor<=l.remaining_minor
        AND ((l.purpose='withdrawal' AND NEW.claim_id IS NULL)
          OR (l.purpose='activity' AND EXISTS (SELECT 1 FROM claims c JOIN reward_inventory r ON r.activity_id=c.activity_id AND r.id=c.inventory_id
            WHERE c.id=NEW.claim_id AND c.activity_id=l.activity_id AND r.amount_minor=-NEW.locked_delta_minor))))))
BEGIN
  SELECT RAISE(ABORT, 'balance lock entry mismatch');
END;
