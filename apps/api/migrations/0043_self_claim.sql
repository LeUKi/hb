-- 自领 (docs/self-claim-design.md, 2026-10-26): the sender may sign up for
-- their own 限时开奖. The guard is as it was, less author_id!=NEW.user_id;
-- a prize the sender draws is not paid (payment_claim_policy_insert still
-- refuses a payment to them).
DROP TRIGGER activity_registrations_insert_guard;--> statement-breakpoint
CREATE TRIGGER activity_registrations_insert_guard BEFORE INSERT ON activity_registrations
WHEN NOT EXISTS(SELECT 1 FROM activities a JOIN users u ON u.id=NEW.user_id
 WHERE a.id=NEW.activity_id AND ((a.participation_mode='password' AND EXISTS(SELECT 1 FROM activity_passwords p WHERE p.id=NEW.password_id AND p.activity_id=a.id)) OR (a.participation_mode='direct' AND NEW.password_id IS NULL AND EXISTS(
 SELECT 1 FROM redemption_submissions s JOIN account_attempt_cooldowns c ON c.user_id=s.user_id AND c.attempt_id=s.id AND c.origin='activity'
 WHERE s.activity_id=a.id AND s.user_id=NEW.user_id AND s.participation_mode='direct'
 AND s.purpose='register' AND s.outcome='pending' AND s.registration_id IS NULL
 AND s.matched_password_id IS NULL AND s.validated_at IS NOT NULL AND s.finished_at IS NULL))) AND a.reward_type='ldc'
 AND json_extract(a.config,'$.money.mode')='timed_draw' AND a.deleted_at IS NULL
 AND a.opened_at IS NOT NULL AND a.ended_at IS NULL AND a.archived_at IS NULL AND a.draw_state='waiting'
 AND a.deadline>CAST((julianday('now')-2440587.5)*86400000 AS INTEGER)
 AND NEW.ordinal=a.registered_count+1
 AND a.registered_count<9007199254740991
 AND (json_extract(a.config,'$.money.participantLimit') IS NULL OR a.registered_count<json_extract(a.config,'$.money.participantLimit'))
 AND NEW.recipient_id=CASE WHEN a.payment_mode='simulation' THEN 'simulation:'||u.external_id ELSE u.external_id END)
BEGIN SELECT RAISE(ABORT,'invalid_draw_registration'); END;
