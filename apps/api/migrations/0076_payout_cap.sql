-- 每人上限 (docs/payout-cap-design.md §2, §3). A merchant that Credit's
-- daily limit refused keeps the day's refusals itself (until when, the
-- smallest amount, how many), so its smaller payments still go that day
-- instead of all waiting behind the one refused. The evidence trigger is as
-- in 0070, and lets one more kind of claim payment end failed: a share over
-- 800 LDC that the daily limit refused twice (once a day, so on two days),
-- with Credit's refusal on record each time and nothing in flight. Never one
-- with an order or an unknown end.
ALTER TABLE `merchants` ADD `quota_until` integer;--> statement-breakpoint
ALTER TABLE `merchants` ADD `quota_below` integer;--> statement-breakpoint
ALTER TABLE `merchants` ADD `quota_refusals` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
-- A merchant held the old way (its refused payment kept as its active one)
-- carries that refusal over: its smaller payments go on at once.
UPDATE merchants SET
  quota_until=(SELECT COALESCE(t.next_send_at,t.next_run_at) FROM payment_tasks t WHERE t.id=merchants.active_task_id),
  quota_below=(SELECT t.amount_minor FROM payment_tasks t WHERE t.id=merchants.active_task_id),
  quota_refusals=1,active_task_id=NULL,paused_reason=NULL
WHERE paused_reason='quota' AND lease_token IS NULL
  AND EXISTS(SELECT 1 FROM payment_tasks t WHERE t.id=merchants.active_task_id
    AND t.status='waiting' AND t.reason='quota' AND t.unknown_outcome=0);--> statement-breakpoint
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
       AND NOT EXISTS(SELECT 1 FROM payment_attempts a WHERE a.task_id=NEW.id AND a.finished_at IS NULL))
     OR (NEW.source='claim' AND NEW.send_block_reason IS 'quota' AND OLD.status='waiting' AND OLD.reason='quota'
       AND NEW.amount_minor>80000
       AND (SELECT COUNT(*) FROM payment_attempts a WHERE a.task_id=NEW.id AND a.operation='send'
         AND a.reason='quota' AND a.no_order_evidence='protocol_rejection_v1')>=2
       AND NOT EXISTS(SELECT 1 FROM payment_attempts a WHERE a.task_id=NEW.id AND a.finished_at IS NULL))))))
BEGIN SELECT RAISE(ABORT, 'observed real payment evidence cannot be cleared'); END;
