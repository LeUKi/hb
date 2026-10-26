-- A claim's payment refused for want of the recipient's Credit account, and
-- not sent again in time, is over: 未发出, the end a refused 转出 already has
-- (docs/redesign/05-hongbao.md §3, 2026-10-26). The trigger is as it was,
-- and lets a claim's payment in as well: from attention, held for its
-- recipient alone under its own order policy, with the upstream's refusal
-- on record and no order anywhere.
DROP TRIGGER payment_tasks_real_evidence_sticky;--> statement-breakpoint
CREATE TRIGGER payment_tasks_real_evidence_sticky BEFORE UPDATE ON payment_tasks
WHEN OLD.mode='real' AND (
 (OLD.order_observed_at IS NOT NULL AND NEW.order_observed_at IS NULL)
 OR (OLD.order_evidence IS NOT NULL AND NEW.order_evidence IS NULL)
 OR (OLD.external_order_id IS NOT NULL AND OLD.external_order_id IS NOT NEW.external_order_id)
 OR (OLD.unknown_outcome=1 AND NEW.unknown_outcome=0 AND NEW.status!='confirmed')
 OR (OLD.status='confirmed' AND NEW.status!='confirmed')
 OR (OLD.status='failed' AND NEW.status!='failed')
 OR (OLD.confirmed_at IS NOT NULL AND OLD.confirmed_at IS NOT NEW.confirmed_at)
 OR (NEW.status='failed' AND OLD.status!='failed' AND (NEW.unknown_outcome!=0
   OR NEW.order_observed_at IS NOT NULL OR NEW.external_order_id IS NOT NULL OR NEW.send_acknowledged_at IS NOT NULL
   OR NOT (
     (NEW.source='withdrawal' AND COALESCE(NEW.send_block_reason,'') IN ('recipient','self_payment','configuration','validation'))
     OR (NEW.source='claim' AND OLD.status='attention' AND NEW.recovery_policy IS 'claim_same_order_v1'
       AND NEW.send_block_reason IS 'recipient'
       AND EXISTS(SELECT 1 FROM payment_attempts a WHERE a.task_id=NEW.id AND a.operation='send'
         AND a.outcome='rejected' AND a.reason='recipient' AND a.no_order_evidence='protocol_rejection_v1')
       AND NOT EXISTS(SELECT 1 FROM payment_attempts a WHERE a.task_id=NEW.id AND a.finished_at IS NULL))))))
BEGIN SELECT RAISE(ABORT, 'observed real payment evidence cannot be cleared'); END;
