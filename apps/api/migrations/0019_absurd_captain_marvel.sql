CREATE TABLE `activity_draw_plans` (
	`activity_id` text PRIMARY KEY NOT NULL,
	`participant_count` integer NOT NULL,
	`payload` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`activity_id`) REFERENCES `activities`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "activity_draw_plans_count_valid" CHECK(typeof("activity_draw_plans"."participant_count")='integer' AND "activity_draw_plans"."participant_count">=0 AND "activity_draw_plans"."participant_count"<=9007199254740991)
);
--> statement-breakpoint
CREATE TABLE `activity_registrations` (
	`id` text PRIMARY KEY NOT NULL,
	`activity_id` text NOT NULL,
	`user_id` text NOT NULL,
	`password_id` text NOT NULL,
	`ordinal` integer NOT NULL,
	`recipient_id` text NOT NULL,
	`registered_at` integer NOT NULL,
	FOREIGN KEY (`activity_id`) REFERENCES `activities`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`password_id`) REFERENCES `activity_passwords`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "activity_registrations_ordinal_positive" CHECK(typeof("activity_registrations"."ordinal")='integer' AND "activity_registrations"."ordinal">0 AND "activity_registrations"."ordinal"<=9007199254740991)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `activity_registrations_user_unique` ON `activity_registrations` (`activity_id`,`user_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `activity_registrations_ordinal_unique` ON `activity_registrations` (`activity_id`,`ordinal`);--> statement-breakpoint
CREATE INDEX `activity_registrations_user_time_idx` ON `activity_registrations` (`user_id`,`registered_at`,`id`);--> statement-breakpoint
ALTER TABLE `activities` ADD `registered_count` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `activities` ADD `draw_state` text;--> statement-breakpoint
ALTER TABLE `activities` ADD `draw_closed_at` integer;--> statement-breakpoint
ALTER TABLE `activities` ADD `draw_reason` text;--> statement-breakpoint
ALTER TABLE `activities` ADD `draw_published_at` integer;--> statement-breakpoint
ALTER TABLE `redemption_submissions` ADD `registration_id` text REFERENCES activity_registrations(id);
--> statement-breakpoint
DROP TRIGGER redemption_submissions_purpose_insert_guard;
--> statement-breakpoint
DROP TRIGGER redemption_submissions_purpose_update_guard;
--> statement-breakpoint
CREATE TRIGGER redemption_submissions_purpose_insert_guard BEFORE INSERT ON redemption_submissions
WHEN NEW.purpose NOT IN ('claim','solve','register')
 OR (NEW.purpose='solve' AND (NEW.outcome NOT IN ('solved','incorrect','ended','archived') OR NEW.claim_id IS NOT NULL OR NEW.registration_id IS NOT NULL OR NEW.finished_at IS NULL))
 OR (NEW.purpose='register' AND (NEW.outcome NOT IN ('registered','already_registered','incorrect','draft','ended','archived') OR NEW.claim_id IS NOT NULL OR NEW.finished_at IS NULL))
 OR (NEW.outcome='solved' AND (NEW.purpose!='solve' OR NEW.matched_password_id IS NULL))
 OR (NEW.outcome IN ('registered','already_registered') AND (NEW.purpose!='register' OR NEW.registration_id IS NULL))
 OR (NEW.purpose!='register' AND NEW.registration_id IS NOT NULL)
 OR EXISTS(SELECT 1 FROM activities WHERE id=NEW.activity_id AND deleted_at IS NOT NULL)
BEGIN SELECT RAISE(ABORT,'invalid_submission_purpose'); END;
--> statement-breakpoint
CREATE TRIGGER redemption_submissions_purpose_update_guard BEFORE UPDATE ON redemption_submissions
WHEN NEW.purpose IS NOT OLD.purpose
 OR (NEW.purpose IN ('solve','register') AND (NEW.outcome IS NOT OLD.outcome OR NEW.matched_password_id IS NOT OLD.matched_password_id OR NEW.claim_id IS NOT NULL OR NEW.registration_id IS NOT OLD.registration_id))
 OR (NEW.outcome='solved' AND NEW.purpose!='solve')
BEGIN SELECT RAISE(ABORT,'immutable_submission_purpose'); END;
--> statement-breakpoint
CREATE INDEX activities_unfinished_draw_idx ON activities(draw_state,deadline,id) WHERE deleted_at IS NULL AND opened_at IS NOT NULL AND draw_state IN ('waiting','settling');
--> statement-breakpoint
CREATE TRIGGER activity_registrations_insert_guard BEFORE INSERT ON activity_registrations
WHEN NOT EXISTS(SELECT 1 FROM activities a JOIN activity_passwords p ON p.activity_id=a.id
 JOIN users u ON u.id=NEW.user_id
 WHERE a.id=NEW.activity_id AND p.id=NEW.password_id AND a.reward_type='ldc'
 AND json_extract(a.config,'$.money.mode')='timed_draw' AND a.deleted_at IS NULL
 AND a.opened_at IS NOT NULL AND a.ended_at IS NULL AND a.archived_at IS NULL AND a.draw_state='waiting'
 AND a.deadline>CAST((julianday('now')-2440587.5)*86400000 AS INTEGER)
 AND a.author_id!=NEW.user_id AND NEW.ordinal=a.registered_count+1
 AND a.registered_count<9007199254740991
 AND (json_extract(a.config,'$.money.participantLimit') IS NULL OR a.registered_count<json_extract(a.config,'$.money.participantLimit'))
 AND NEW.recipient_id=CASE WHEN a.payment_mode='simulation' THEN 'simulation:'||u.external_id ELSE u.external_id END)
BEGIN SELECT RAISE(ABORT,'invalid_draw_registration'); END;
--> statement-breakpoint
CREATE TRIGGER activity_registrations_immutable BEFORE UPDATE ON activity_registrations
BEGIN SELECT RAISE(ABORT,'immutable_draw_registration'); END;
--> statement-breakpoint
CREATE TRIGGER activity_draw_plans_insert_guard BEFORE INSERT ON activity_draw_plans
WHEN EXISTS(SELECT 1 FROM activity_draw_plans WHERE activity_id=NEW.activity_id)
 OR NOT EXISTS(SELECT 1 FROM activities WHERE id=NEW.activity_id AND draw_state='settling'
   AND registered_count=NEW.participant_count AND draw_closed_at IS NOT NULL)
 OR NOT json_valid(NEW.payload)
BEGIN SELECT RAISE(ABORT,'invalid_draw_plan'); END;
--> statement-breakpoint
CREATE TRIGGER activity_draw_plans_immutable BEFORE UPDATE ON activity_draw_plans
BEGIN SELECT RAISE(ABORT,'immutable_draw_plan'); END;
--> statement-breakpoint
CREATE TRIGGER activities_draw_config_immutable BEFORE UPDATE ON activities
WHEN OLD.opened_at IS NOT NULL AND json_extract(OLD.config,'$.money.mode')='timed_draw'
 AND (json_extract(NEW.config,'$.money') IS NOT json_extract(OLD.config,'$.money')
   OR NEW.merchant_id IS NOT OLD.merchant_id OR NEW.allocation IS NOT OLD.allocation
   OR NEW.total_count IS NOT OLD.total_count OR NEW.deadline IS NOT OLD.deadline)
BEGIN SELECT RAISE(ABORT,'immutable_draw_config'); END;
--> statement-breakpoint
CREATE TRIGGER activities_draw_state_guard BEFORE UPDATE ON activities
WHEN OLD.draw_state IN ('completed','empty') AND (NEW.draw_state IS NOT OLD.draw_state
 OR NEW.draw_closed_at IS NOT OLD.draw_closed_at OR NEW.draw_published_at IS NOT OLD.draw_published_at)
BEGIN SELECT RAISE(ABORT,'immutable_draw_result'); END;
--> statement-breakpoint
CREATE TRIGGER claims_timed_draw_guard BEFORE INSERT ON claims
WHEN EXISTS(SELECT 1 FROM activities WHERE id=NEW.activity_id AND json_extract(config,'$.money.mode')='timed_draw')
 AND NOT EXISTS(SELECT 1 FROM activities a JOIN activity_draw_plans d ON d.activity_id=a.id
   JOIN json_each(d.payload,'$.winners') w
   WHERE a.id=NEW.activity_id AND a.draw_state='settling'
   AND json_extract(w.value,'$.claimId')=NEW.id AND json_extract(w.value,'$.userId')=NEW.user_id
   AND json_extract(w.value,'$.inventoryId')=NEW.inventory_id AND json_extract(w.value,'$.passwordId')=NEW.password_id)
BEGIN SELECT RAISE(ABORT,'invalid_draw_claim'); END;
