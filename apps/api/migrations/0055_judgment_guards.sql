-- 写判定时不再数一遍 (docs/programmable-hongbao-design.md §3, 热点,
-- 2026-10-31): a judgment's sequence and attempt, and a 动态 line's n,
-- are checked against the largest so far plus one, read from the unique
-- indexes, instead of counting every row of the 红包 (485 rows read for
-- each judgment of a 1073-judgment 红包, growing with each). The same
-- numbers: they start at 0 and run on without gaps, rows are never
-- deleted, and these guards have always held them so.
DROP TRIGGER code_judgments_insert_guard;
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
 OR NEW.attempt IS NOT (SELECT COALESCE(MAX(attempt)+1,0) FROM code_judgments WHERE activity_id=NEW.activity_id AND user_id=NEW.user_id)
 OR NEW.sequence IS NOT (SELECT COALESCE(MAX(sequence)+1,0) FROM code_judgments WHERE activity_id=NEW.activity_id)
BEGIN SELECT RAISE(ABORT,'invalid_code_judgment'); END;
--> statement-breakpoint
DROP TRIGGER activity_announcements_insert_guard;
--> statement-breakpoint
CREATE TRIGGER activity_announcements_insert_guard BEFORE INSERT ON activity_announcements
WHEN NOT EXISTS(SELECT 1 FROM code_judgments j JOIN activity_code c ON c.activity_id=j.activity_id
   WHERE j.submission_row_id=NEW.submission_row_id AND j.activity_id=NEW.activity_id AND j.user_id=NEW.user_id
     AND c.protocol>=4)
 OR NEW.n IS NOT (SELECT COALESCE(MAX(n)+1,0) FROM activity_announcements WHERE activity_id=NEW.activity_id)
BEGIN SELECT RAISE(ABORT,'invalid_activity_announcement'); END;
