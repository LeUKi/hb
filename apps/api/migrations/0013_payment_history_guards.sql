-- SQLite REPLACE may bypass DELETE triggers when recursive_triggers is disabled.
-- Reject an insertion that would replace durable payment identity or permits.
CREATE TRIGGER payment_retry_grants_no_replace BEFORE INSERT ON payment_retry_grants
WHEN EXISTS(SELECT 1 FROM payment_retry_grants WHERE task_id=NEW.task_id)
BEGIN SELECT RAISE(ABORT, 'retry grant cannot be replaced'); END;
--> statement-breakpoint
CREATE TRIGGER payment_duplicate_probes_no_replace BEFORE INSERT ON payment_duplicate_probes
WHEN EXISTS(SELECT 1 FROM payment_duplicate_probes WHERE task_id=NEW.task_id)
BEGIN SELECT RAISE(ABORT, 'duplicate probe cannot be replaced'); END;
--> statement-breakpoint
CREATE TRIGGER payment_acceptances_no_replace BEFORE INSERT ON payment_acceptances
WHEN EXISTS(SELECT 1 FROM payment_acceptances WHERE id=NEW.id OR (client_id=NEW.client_id AND business_no=NEW.business_no))
BEGIN SELECT RAISE(ABORT, 'acceptance cannot be replaced'); END;
--> statement-breakpoint
CREATE TRIGGER payment_tasks_no_replace BEFORE INSERT ON payment_tasks
WHEN EXISTS(SELECT 1 FROM payment_tasks WHERE id=NEW.id OR (client_id=NEW.client_id AND business_no=NEW.business_no)
 OR claim_id=NEW.claim_id OR acceptance_id=NEW.acceptance_id)
BEGIN SELECT RAISE(ABORT, 'payment task cannot be replaced'); END;
