-- 奖励发放：余额不足终止 (docs/payout-stop-design.md §1, §7). A merchant whose
-- Credit balance ran short keeps when its wait began; three days on, the
-- payments job stops the ones never sent, and tells each sender of a wait
-- once (funds_noticed_at). Merchants already waiting on funds are left to
-- the job, which counts from their first 余额不足: one past three days stops
-- at its first run (§6 point 1, user 2026-11-16). The evidence trigger is as
-- it was, and lets
-- a claim's payment end failed for funds too: never sent (pending, no
-- attempt at all), or held by 余额不足 with Credit's refusal on record and
-- nothing in flight. Never one with an order or an unknown end.
ALTER TABLE `merchants` ADD `funds_wait_since` integer;--> statement-breakpoint
ALTER TABLE `merchants` ADD `funds_noticed_at` integer;--> statement-breakpoint
CREATE INDEX `merchants_funds_wait_idx` ON `merchants` (`funds_wait_since`) WHERE "merchants"."funds_wait_since" IS NOT NULL;--> statement-breakpoint
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
       AND NOT EXISTS(SELECT 1 FROM payment_attempts a WHERE a.task_id=NEW.id AND a.finished_at IS NULL))
     OR (NEW.source='claim' AND NEW.send_block_reason IS 'funds' AND OLD.status='pending'
       AND OLD.first_send_at IS NULL
       AND NOT EXISTS(SELECT 1 FROM payment_attempts a WHERE a.task_id=NEW.id))
     OR (NEW.source='claim' AND NEW.send_block_reason IS 'funds' AND OLD.status='waiting' AND OLD.reason='funds'
       AND EXISTS(SELECT 1 FROM payment_attempts a WHERE a.task_id=NEW.id AND a.operation='send'
         AND a.reason='funds' AND a.no_order_evidence='protocol_rejection_v1')
       AND NOT EXISTS(SELECT 1 FROM payment_attempts a WHERE a.task_id=NEW.id AND a.finished_at IS NULL))))))
BEGIN SELECT RAISE(ABORT, 'observed real payment evidence cannot be cleared'); END;
