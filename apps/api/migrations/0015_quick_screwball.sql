CREATE TABLE `payment_username_corrections` (
	`task_id` text PRIMARY KEY NOT NULL,
	`original_username` text NOT NULL,
	`corrected_username` text NOT NULL,
	`original_parameter_digest` text NOT NULL,
	`corrected_parameter_digest` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`task_id`) REFERENCES `payment_tasks`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "payment_username_corrections_case_only" CHECK("payment_username_corrections"."original_username" != "payment_username_corrections"."corrected_username" AND lower("payment_username_corrections"."original_username") = lower("payment_username_corrections"."corrected_username") AND length("payment_username_corrections"."corrected_username") BETWEEN 1 AND 255 AND "payment_username_corrections"."corrected_username" NOT GLOB '*[^A-Za-z0-9_-]*'),
	CONSTRAINT "payment_username_corrections_digest_valid" CHECK(length("payment_username_corrections"."original_parameter_digest") = 64 AND "payment_username_corrections"."original_parameter_digest" NOT GLOB '*[^0-9a-f]*' AND length("payment_username_corrections"."corrected_parameter_digest") = 64 AND "payment_username_corrections"."corrected_parameter_digest" NOT GLOB '*[^0-9a-f]*' AND "payment_username_corrections"."original_parameter_digest" != "payment_username_corrections"."corrected_parameter_digest")
);
--> statement-breakpoint
ALTER TABLE `payment_attempts` ADD `recipient_username` text;--> statement-breakpoint
ALTER TABLE `payment_attempts` ADD `parameter_digest` text;
--> statement-breakpoint
UPDATE payment_attempts SET recipient_username=(SELECT p.recipient_username FROM payment_tasks p WHERE p.id=payment_attempts.task_id)
 WHERE operation='send' AND EXISTS(SELECT 1 FROM payment_tasks p WHERE p.id=payment_attempts.task_id AND p.mode='real');
--> statement-breakpoint
CREATE TRIGGER payment_username_corrections_insert_guard BEFORE INSERT ON payment_username_corrections
WHEN EXISTS(SELECT 1 FROM payment_username_corrections c WHERE c.task_id=NEW.task_id)
 OR NOT EXISTS(SELECT 1 FROM payment_tasks p JOIN payment_retry_grants g ON g.task_id=p.id JOIN merchants m ON m.id=p.merchant_id
  WHERE p.id=NEW.task_id AND p.mode='real' AND p.source='acceptance' AND p.status!='confirmed'
   AND p.recipient_username=NEW.original_username AND p.send_block_reason='recipient'
   AND p.order_observed_at IS NULL AND p.order_evidence IS NULL AND p.external_order_id IS NULL AND p.send_acknowledged_at IS NULL
   AND m.lease_token IS NULL AND g.parameter_digest=NEW.original_parameter_digest
   AND g.revoked_at IS NULL AND g.expires_at>NEW.created_at AND g.used_additional_sends<g.max_additional_sends)
 OR EXISTS(SELECT 1 FROM payment_duplicate_probes d WHERE d.task_id=NEW.task_id)
BEGIN SELECT RAISE(ABORT, 'username correction requires an unused recovery opportunity and no observed order'); END;
--> statement-breakpoint
CREATE TRIGGER payment_username_corrections_immutable BEFORE UPDATE ON payment_username_corrections
BEGIN SELECT RAISE(ABORT, 'username correction history is immutable'); END;
--> statement-breakpoint
CREATE TRIGGER payment_username_corrections_no_delete BEFORE DELETE ON payment_username_corrections
BEGIN SELECT RAISE(ABORT, 'username correction history cannot be deleted'); END;
--> statement-breakpoint
CREATE TRIGGER payment_username_corrections_resume AFTER INSERT ON payment_username_corrections
BEGIN
 UPDATE payment_tasks SET status='reconciling',send_block_reason=NULL,next_action='query',
  next_query_at=MAX(NEW.created_at,COALESCE(query_retry_after_at,0)),next_run_at=MAX(NEW.created_at,COALESCE(query_retry_after_at,0)),
  next_send_at=MAX(COALESCE(next_send_at,0),NEW.created_at+10000,COALESCE(query_retry_after_at,0)),
  queried_send_count=NULL,queried_recovery_version=NULL,recovery_version=recovery_version+1,updated_at=NEW.created_at
 WHERE id=NEW.task_id;
END;
--> statement-breakpoint
CREATE TRIGGER payment_attempts_request_identity_immutable BEFORE UPDATE ON payment_attempts
WHEN OLD.recipient_username IS NOT NEW.recipient_username OR OLD.parameter_digest IS NOT NEW.parameter_digest
BEGIN SELECT RAISE(ABORT, 'attempt request identity is immutable'); END;
--> statement-breakpoint
CREATE TRIGGER payment_attempts_no_replace BEFORE INSERT ON payment_attempts
WHEN EXISTS(SELECT 1 FROM payment_attempts a WHERE a.id=NEW.id)
BEGIN SELECT RAISE(ABORT, 'attempt history cannot be replaced'); END;
--> statement-breakpoint
DROP TRIGGER payment_duplicate_probes_insert_guard;
--> statement-breakpoint
CREATE TRIGGER payment_duplicate_probes_insert_guard BEFORE INSERT ON payment_duplicate_probes
WHEN NOT EXISTS (SELECT 1 FROM payment_tasks p JOIN payment_retry_grants g ON g.task_id=p.id
 LEFT JOIN payment_username_corrections c ON c.task_id=p.id
 WHERE p.id=NEW.task_id AND p.mode='real' AND p.source='acceptance' AND p.status='confirmed'
 AND p.external_order_id=NEW.baseline_external_order_id AND COALESCE(c.corrected_parameter_digest,g.parameter_digest)=NEW.parameter_digest)
 OR NEW.status!='pending' OR NEW.permit_consumed_at IS NOT NULL OR NEW.protocol_verified_at IS NOT NULL
 OR NEW.backend_verified_at IS NOT NULL OR NEW.query_count!=0
BEGIN SELECT RAISE(ABORT, 'duplicate probe requires a confirmed matching acceptance'); END;
