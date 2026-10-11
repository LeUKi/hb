-- Preserve existing records and guards while allowing explicit direct participation.
PRAGMA defer_foreign_keys=ON;--> statement-breakpoint
DROP TRIGGER activities_delete_guard;--> statement-breakpoint
DROP TRIGGER activity_registrations_immutable;--> statement-breakpoint
DROP TRIGGER activity_registrations_insert_guard;--> statement-breakpoint
DROP TRIGGER claims_deleted_guard;--> statement-breakpoint
DROP TRIGGER claims_timed_draw_guard;--> statement-breakpoint
DROP TRIGGER payment_claim_policy_insert;--> statement-breakpoint
DROP TRIGGER payment_tasks_insert_consistency;--> statement-breakpoint
DROP TRIGGER redemption_submissions_purpose_insert_guard;--> statement-breakpoint
DROP TRIGGER redemption_submissions_purpose_update_guard;--> statement-breakpoint
CREATE TABLE `__new_activity_registrations` (
	`id` text PRIMARY KEY NOT NULL,
	`activity_id` text NOT NULL,
	`user_id` text NOT NULL,
	`password_id` text,
	`ordinal` integer NOT NULL,
	`recipient_id` text NOT NULL,
	`registered_at` integer NOT NULL,
	FOREIGN KEY (`activity_id`) REFERENCES `activities`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`password_id`) REFERENCES `activity_passwords`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "activity_registrations_ordinal_positive" CHECK(typeof("__new_activity_registrations"."ordinal")='integer' AND "__new_activity_registrations"."ordinal">0 AND "__new_activity_registrations"."ordinal"<=9007199254740991)
);
--> statement-breakpoint
INSERT INTO `__new_activity_registrations`("id", "activity_id", "user_id", "password_id", "ordinal", "recipient_id", "registered_at") SELECT "id", "activity_id", "user_id", "password_id", "ordinal", "recipient_id", "registered_at" FROM `activity_registrations`;--> statement-breakpoint
DROP TABLE `activity_registrations`;--> statement-breakpoint
ALTER TABLE `__new_activity_registrations` RENAME TO `activity_registrations`;--> statement-breakpoint
CREATE UNIQUE INDEX `activity_registrations_user_unique` ON `activity_registrations` (`activity_id`,`user_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `activity_registrations_ordinal_unique` ON `activity_registrations` (`activity_id`,`ordinal`);--> statement-breakpoint
CREATE INDEX `activity_registrations_user_time_idx` ON `activity_registrations` (`user_id`,`registered_at`,`id`);--> statement-breakpoint
CREATE TABLE `__new_claims` (
	`id` text PRIMARY KEY NOT NULL,
	`activity_id` text NOT NULL,
	`user_id` text NOT NULL,
	`inventory_id` text NOT NULL,
	`password_id` text,
	`claimed_at` integer NOT NULL,
	FOREIGN KEY (`activity_id`) REFERENCES `activities`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`password_id`) REFERENCES `activity_passwords`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`activity_id`,`inventory_id`) REFERENCES `reward_inventory`(`activity_id`,`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_claims`("id", "activity_id", "user_id", "inventory_id", "password_id", "claimed_at") SELECT "id", "activity_id", "user_id", "inventory_id", "password_id", "claimed_at" FROM `claims`;--> statement-breakpoint
DROP TABLE `claims`;--> statement-breakpoint
ALTER TABLE `__new_claims` RENAME TO `claims`;--> statement-breakpoint
CREATE UNIQUE INDEX `claims_activity_user_unique` ON `claims` (`activity_id`,`user_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `claims_activity_inventory_unique` ON `claims` (`activity_id`,`inventory_id`);--> statement-breakpoint
CREATE INDEX `claims_user_time_idx` ON `claims` (`user_id`,`claimed_at`,`id`);--> statement-breakpoint
CREATE INDEX `claims_activity_time_idx` ON `claims` (`activity_id`,`claimed_at`,`id`);--> statement-breakpoint
ALTER TABLE `activities` ADD `participation_mode` text DEFAULT 'password' NOT NULL;--> statement-breakpoint
ALTER TABLE `redemption_submissions` ADD `participation_mode` text DEFAULT 'password' NOT NULL;
--> statement-breakpoint
CREATE TRIGGER activities_delete_guard BEFORE UPDATE OF deleted_at ON activities
WHEN NEW.deleted_at IS NOT NULL AND (OLD.opened_at IS NOT NULL OR NEW.opened_at IS NOT NULL
  OR EXISTS(SELECT 1 FROM claims WHERE activity_id=OLD.id)
  OR EXISTS(SELECT 1 FROM redemption_submissions WHERE activity_id=OLD.id AND matched_password_id IS NOT NULL))
BEGIN SELECT RAISE(ABORT,'activity_not_deletable'); END;
--> statement-breakpoint
CREATE TRIGGER activity_registrations_immutable BEFORE UPDATE ON activity_registrations
BEGIN SELECT RAISE(ABORT,'immutable_draw_registration'); END;
--> statement-breakpoint
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
 AND a.author_id!=NEW.user_id AND NEW.ordinal=a.registered_count+1
 AND a.registered_count<9007199254740991
 AND (json_extract(a.config,'$.money.participantLimit') IS NULL OR a.registered_count<json_extract(a.config,'$.money.participantLimit'))
 AND NEW.recipient_id=CASE WHEN a.payment_mode='simulation' THEN 'simulation:'||u.external_id ELSE u.external_id END)
BEGIN SELECT RAISE(ABORT,'invalid_draw_registration'); END;
--> statement-breakpoint
CREATE TRIGGER claims_deleted_guard BEFORE INSERT ON claims
WHEN EXISTS(SELECT 1 FROM activities WHERE id=NEW.activity_id AND deleted_at IS NOT NULL)
BEGIN SELECT RAISE(ABORT,'activity_deleted'); END;
--> statement-breakpoint
CREATE TRIGGER claims_timed_draw_guard BEFORE INSERT ON claims
WHEN EXISTS(SELECT 1 FROM activities WHERE id=NEW.activity_id AND json_extract(config,'$.money.mode')='timed_draw')
 AND NOT EXISTS(SELECT 1 FROM activities a JOIN activity_draw_plans d ON d.activity_id=a.id
   JOIN json_each(d.payload,'$.winners') w
   WHERE a.id=NEW.activity_id AND a.draw_state='settling'
   AND json_extract(w.value,'$.claimId')=NEW.id AND json_extract(w.value,'$.userId')=NEW.user_id
   AND json_extract(w.value,'$.inventoryId')=NEW.inventory_id AND json_extract(w.value,'$.passwordId') IS NEW.password_id
   AND ((a.participation_mode='password' AND json_type(w.value,'$.passwordId')='text')
     OR (a.participation_mode='direct' AND json_type(w.value,'$.passwordId')='null')))
BEGIN SELECT RAISE(ABORT,'invalid_draw_claim'); END;
--> statement-breakpoint
CREATE TRIGGER payment_claim_policy_insert BEFORE INSERT ON payment_tasks
WHEN (NEW.source='claim' AND NEW.mode='real' AND (
 NEW.recovery_policy IS NOT 'claim_same_order_v1' OR NEW.parameter_digest IS NULL
 OR length(NEW.parameter_digest)!=64 OR NEW.parameter_digest GLOB '*[^0-9a-f]*'
 OR NEW.first_send_at IS NOT NULL
 OR NOT EXISTS(SELECT 1 FROM claims c JOIN users u ON u.id=c.user_id
    JOIN activities a ON a.id=c.activity_id
    JOIN reward_inventory r ON r.id=c.inventory_id AND r.activity_id=a.id
    WHERE c.id=NEW.claim_id AND u.external_id=NEW.recipient_id
      AND u.username=NEW.recipient_username AND a.opened_at IS NOT NULL
      AND a.author_id!=c.user_id AND a.merchant_id=NEW.merchant_id
      AND a.payment_mode='real' AND r.kind='ldc' AND r.amount_minor=NEW.amount_minor)
)) OR ((NEW.source!='claim' OR NEW.mode!='real') AND (NEW.recovery_policy IS NOT NULL OR NEW.parameter_digest IS NOT NULL OR NEW.first_send_at IS NOT NULL))
BEGIN SELECT RAISE(ABORT, 'ordinary payment authorization mismatch'); END;
--> statement-breakpoint
CREATE TRIGGER payment_tasks_insert_consistency BEFORE INSERT ON payment_tasks
WHEN NOT EXISTS (SELECT 1 FROM merchants WHERE id=NEW.merchant_id AND client_id=NEW.client_id AND mode=NEW.mode)
OR (NEW.source='claim' AND NOT EXISTS (
 SELECT 1 FROM claims c JOIN activities a ON a.id=c.activity_id JOIN reward_inventory r ON r.id=c.inventory_id
 WHERE c.id=NEW.claim_id AND a.reward_type='ldc' AND a.merchant_id=NEW.merchant_id AND a.payment_mode=NEW.mode AND r.amount_minor=NEW.amount_minor
))
OR (NEW.source='acceptance' AND NOT EXISTS (
 SELECT 1 FROM payment_acceptances a WHERE a.id=NEW.acceptance_id AND a.merchant_id=NEW.merchant_id
 AND a.client_id=NEW.client_id AND a.business_no=NEW.business_no AND a.recipient_id=NEW.recipient_id
 AND a.recipient_username=NEW.recipient_username AND a.amount_minor=NEW.amount_minor
))
BEGIN SELECT RAISE(ABORT, 'payment task is inconsistent'); END;
--> statement-breakpoint
CREATE TRIGGER activities_participation_insert_guard BEFORE INSERT ON activities
WHEN NEW.participation_mode NOT IN ('password','direct')
 OR (NEW.deleted_at IS NULL AND COALESCE(json_extract(NEW.config,'$.participationMode'),'password') IS NOT NEW.participation_mode)
 OR (NEW.participation_mode='direct' AND NEW.force_dedicated!=0)
BEGIN SELECT RAISE(ABORT,'invalid_participation_mode'); END;
--> statement-breakpoint
CREATE TRIGGER activities_participation_update_guard BEFORE UPDATE ON activities
WHEN NEW.participation_mode NOT IN ('password','direct')
 OR (OLD.opened_at IS NOT NULL AND NEW.participation_mode IS NOT OLD.participation_mode)
 OR (NEW.deleted_at IS NULL AND COALESCE(json_extract(NEW.config,'$.participationMode'),'password') IS NOT NEW.participation_mode)
 OR (NEW.participation_mode='direct' AND NEW.force_dedicated!=0)
BEGIN SELECT RAISE(ABORT,'invalid_participation_mode'); END;
--> statement-breakpoint
CREATE TRIGGER activities_participation_open_guard BEFORE UPDATE OF opened_at ON activities
WHEN OLD.opened_at IS NULL AND NEW.opened_at IS NOT NULL AND (
 (NEW.participation_mode='password' AND NOT EXISTS(SELECT 1 FROM activity_passwords WHERE activity_id=NEW.id))
 OR (NEW.participation_mode='direct' AND EXISTS(SELECT 1 FROM activity_passwords WHERE activity_id=NEW.id)))
BEGIN SELECT RAISE(ABORT,'invalid_participation_passwords'); END;
--> statement-breakpoint
CREATE TRIGGER activity_passwords_participation_guard BEFORE INSERT ON activity_passwords
WHEN EXISTS(SELECT 1 FROM activities WHERE id=NEW.activity_id AND participation_mode='direct')
BEGIN SELECT RAISE(ABORT,'direct_activity_has_no_passwords'); END;
--> statement-breakpoint
CREATE TRIGGER activity_passwords_participation_update_guard BEFORE UPDATE OF activity_id ON activity_passwords
WHEN EXISTS(SELECT 1 FROM activities WHERE id=NEW.activity_id AND participation_mode='direct')
BEGIN SELECT RAISE(ABORT,'direct_activity_has_no_passwords'); END;
--> statement-breakpoint
CREATE TRIGGER redemption_submissions_purpose_insert_guard BEFORE INSERT ON redemption_submissions
WHEN NEW.purpose NOT IN ('claim','solve','register')
 OR (NEW.purpose='solve' AND (NEW.outcome NOT IN ('solved','incorrect','ended','archived') OR NEW.claim_id IS NOT NULL OR NEW.registration_id IS NOT NULL OR NEW.finished_at IS NULL))
 OR (NEW.purpose='register' AND (
   NEW.claim_id IS NOT NULL OR NOT (
     (NEW.outcome IN ('registered','already_registered','incorrect','draft','ended','archived') AND NEW.finished_at IS NOT NULL)
     OR (NEW.participation_mode='direct' AND NEW.outcome='pending' AND NEW.registration_id IS NULL AND NEW.matched_password_id IS NULL AND NEW.validated_at IS NOT NULL AND NEW.finished_at IS NULL))))
 OR (NEW.outcome='solved' AND (NEW.purpose!='solve' OR NEW.matched_password_id IS NULL))
 OR (NEW.outcome IN ('registered','already_registered') AND (NEW.purpose!='register' OR NEW.registration_id IS NULL))
 OR (NEW.purpose!='register' AND NEW.registration_id IS NOT NULL)
 OR EXISTS(SELECT 1 FROM activities WHERE id=NEW.activity_id AND deleted_at IS NOT NULL)
BEGIN SELECT RAISE(ABORT,'invalid_submission_purpose'); END;
--> statement-breakpoint
CREATE TRIGGER redemption_submissions_purpose_update_guard BEFORE UPDATE ON redemption_submissions
WHEN NEW.purpose IS NOT OLD.purpose
 OR (NEW.purpose='solve' AND (NEW.outcome IS NOT OLD.outcome OR NEW.matched_password_id IS NOT OLD.matched_password_id OR NEW.claim_id IS NOT NULL OR NEW.registration_id IS NOT OLD.registration_id))
 OR (NEW.purpose='register' AND (
   NEW.claim_id IS NOT NULL OR NEW.matched_password_id IS NOT OLD.matched_password_id
   OR ((NEW.outcome IS NOT OLD.outcome OR NEW.registration_id IS NOT OLD.registration_id) AND NOT (
     OLD.participation_mode='direct' AND OLD.outcome='pending' AND NEW.outcome='registered'
     AND NEW.finished_at IS NOT NULL AND NEW.validated_at IS OLD.validated_at AND NEW.validated_at IS NOT NULL
     AND EXISTS(SELECT 1 FROM activity_registrations r WHERE r.id=NEW.registration_id AND r.activity_id=NEW.activity_id AND r.user_id=NEW.user_id AND r.password_id IS NULL)))
   OR (OLD.participation_mode='direct' AND (
     NEW.id IS NOT OLD.id OR NEW.activity_id IS NOT OLD.activity_id OR NEW.user_id IS NOT OLD.user_id
     OR NEW.submission_id IS NOT OLD.submission_id OR NEW.fingerprint IS NOT OLD.fingerprint
     OR NEW.created_at IS NOT OLD.created_at OR NEW.validated_at IS NOT OLD.validated_at
     OR (OLD.outcome!='pending' AND NEW.finished_at IS NOT OLD.finished_at)))))
 OR (NEW.outcome='solved' AND NEW.purpose!='solve')
BEGIN SELECT RAISE(ABORT,'immutable_submission_purpose'); END;
--> statement-breakpoint
CREATE TRIGGER redemption_submissions_mode_insert_guard BEFORE INSERT ON redemption_submissions
WHEN NEW.participation_mode NOT IN ('password','direct')
 OR NOT EXISTS(SELECT 1 FROM activities WHERE id=NEW.activity_id AND participation_mode=NEW.participation_mode)
 OR (NEW.participation_mode='direct' AND (NEW.purpose NOT IN ('claim','register') OR NEW.matched_password_id IS NOT NULL OR NEW.outcome IN ('incorrect','solved')))
 OR (NEW.participation_mode='direct' AND NEW.outcome='pending' AND NOT EXISTS(SELECT 1 FROM account_attempt_cooldowns c WHERE c.user_id=NEW.user_id AND c.attempt_id=NEW.id AND c.origin='activity'))
 OR (NEW.matched_password_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM activity_passwords WHERE id=NEW.matched_password_id AND activity_id=NEW.activity_id))
BEGIN SELECT RAISE(ABORT,'invalid_submission_participation'); END;
--> statement-breakpoint
CREATE TRIGGER redemption_submissions_mode_update_guard BEFORE UPDATE ON redemption_submissions
WHEN NEW.participation_mode IS NOT OLD.participation_mode
 OR (NEW.participation_mode='direct' AND (NEW.purpose NOT IN ('claim','register') OR NEW.matched_password_id IS NOT NULL OR NEW.outcome IN ('incorrect','solved')))
BEGIN SELECT RAISE(ABORT,'immutable_submission_participation'); END;
--> statement-breakpoint
CREATE TRIGGER claims_participation_insert_guard BEFORE INSERT ON claims
WHEN NOT EXISTS(SELECT 1 FROM activities a WHERE a.id=NEW.activity_id AND (
 (a.participation_mode='password' AND EXISTS(SELECT 1 FROM activity_passwords p WHERE p.id=NEW.password_id AND p.activity_id=a.id))
 OR (a.participation_mode='direct' AND NEW.password_id IS NULL AND (
   json_extract(a.config,'$.money.mode')='timed_draw'
   OR EXISTS(SELECT 1 FROM redemption_submissions s WHERE s.activity_id=a.id AND s.user_id=NEW.user_id
     AND s.participation_mode='direct' AND s.purpose='claim' AND s.outcome='pending' AND s.validated_at IS NOT NULL AND s.matched_password_id IS NULL)
 ))))
BEGIN SELECT RAISE(ABORT,'invalid_claim_participation'); END;
--> statement-breakpoint
PRAGMA defer_foreign_keys=OFF;
