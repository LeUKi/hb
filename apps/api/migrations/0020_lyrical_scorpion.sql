CREATE TABLE `merchant_client_ids` (
	`client_id` text PRIMARY KEY NOT NULL,
	`merchant_id` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`merchant_id`) REFERENCES `merchants`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `merchant_client_ids_merchant_idx` ON `merchant_client_ids` (`merchant_id`);--> statement-breakpoint
CREATE TABLE `merchant_config_changes` (
	`id` text PRIMARY KEY NOT NULL,
	`merchant_id` text NOT NULL,
	`request_id` text NOT NULL,
	`request_digest` text NOT NULL,
	`result_version` integer NOT NULL,
	`credential_version` integer NOT NULL,
	`client_id` text NOT NULL,
	`purpose` text NOT NULL,
	`task_id` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`merchant_id`) REFERENCES `merchants`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`task_id`) REFERENCES `payment_tasks`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `merchant_config_changes_request_unique` ON `merchant_config_changes` (`merchant_id`,`request_id`);--> statement-breakpoint
CREATE TABLE `payment_identity_corrections` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`version` integer NOT NULL,
	`original_client_id` text NOT NULL,
	`corrected_client_id` text NOT NULL,
	`original_parameter_digest` text NOT NULL,
	`corrected_parameter_digest` text NOT NULL,
	`merchant_version` integer NOT NULL,
	`credential_version` integer NOT NULL,
	`evidence` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`task_id`) REFERENCES `payment_tasks`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `payment_identity_corrections_version_unique` ON `payment_identity_corrections` (`task_id`,`version`);--> statement-breakpoint
ALTER TABLE `merchant_credentials` ADD `client_id` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `payment_attempts` ADD `client_id` text;--> statement-breakpoint
ALTER TABLE `payment_attempts` ADD `identity_correction_version` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `payment_attempts` ADD `no_order_evidence` text;--> statement-breakpoint
INSERT INTO merchant_client_ids(client_id,merchant_id,created_at) SELECT client_id,id,created_at FROM merchants;
--> statement-breakpoint
UPDATE merchant_credentials SET client_id=(SELECT client_id FROM merchants WHERE id=merchant_credentials.merchant_id);
--> statement-breakpoint
UPDATE payment_attempts SET client_id=(SELECT client_id FROM payment_tasks WHERE id=payment_attempts.task_id);
--> statement-breakpoint
DROP TRIGGER merchants_identity_immutable;
--> statement-breakpoint
CREATE TRIGGER merchants_identity_immutable BEFORE UPDATE OF author_id ON merchants
WHEN NEW.author_id IS NOT OLD.author_id
BEGIN SELECT RAISE(ABORT,'merchant owner is immutable'); END;
--> statement-breakpoint
CREATE TRIGGER merchants_register_client AFTER INSERT ON merchants
BEGIN INSERT INTO merchant_client_ids(client_id,merchant_id,created_at) VALUES(NEW.client_id,NEW.id,NEW.created_at); END;
--> statement-breakpoint
CREATE TRIGGER merchants_current_client_guard BEFORE UPDATE OF client_id ON merchants
WHEN NOT EXISTS(SELECT 1 FROM merchant_client_ids WHERE client_id=NEW.client_id AND merchant_id=NEW.id)
 OR (NEW.client_id IS NOT OLD.client_id AND NEW.version!=OLD.version+1)
BEGIN SELECT RAISE(ABORT,'merchant client registration required'); END;
--> statement-breakpoint
CREATE TRIGGER merchant_client_ids_immutable BEFORE UPDATE ON merchant_client_ids
BEGIN SELECT RAISE(ABORT,'client ownership is permanent'); END;
--> statement-breakpoint
CREATE TRIGGER merchant_client_ids_no_delete BEFORE DELETE ON merchant_client_ids
BEGIN SELECT RAISE(ABORT,'client ownership is permanent'); END;
--> statement-breakpoint
CREATE TRIGGER merchant_client_ids_no_replace BEFORE INSERT ON merchant_client_ids
WHEN EXISTS(SELECT 1 FROM merchant_client_ids WHERE client_id=NEW.client_id)
BEGIN SELECT RAISE(ABORT,'client ownership is permanent'); END;
--> statement-breakpoint
CREATE TRIGGER merchant_credentials_snapshot_insert BEFORE INSERT ON merchant_credentials
WHEN NEW.client_id!='' AND NOT EXISTS(SELECT 1 FROM merchant_client_ids WHERE merchant_id=NEW.merchant_id AND client_id=NEW.client_id)
BEGIN SELECT RAISE(ABORT,'credential client does not belong to merchant'); END;
--> statement-breakpoint
CREATE TRIGGER merchant_credentials_snapshot_default AFTER INSERT ON merchant_credentials
WHEN NEW.client_id=''
BEGIN UPDATE merchant_credentials SET client_id=(SELECT client_id FROM merchants WHERE id=NEW.merchant_id) WHERE id=NEW.id; END;
--> statement-breakpoint
CREATE TRIGGER merchant_credentials_snapshot_immutable BEFORE UPDATE ON merchant_credentials
WHEN NEW.merchant_id IS NOT OLD.merchant_id OR NEW.version IS NOT OLD.version OR NEW.ciphertext IS NOT OLD.ciphertext
 OR (OLD.client_id!='' AND NEW.client_id IS NOT OLD.client_id)
 OR NOT EXISTS(SELECT 1 FROM merchant_client_ids WHERE merchant_id=NEW.merchant_id AND client_id=NEW.client_id)
BEGIN SELECT RAISE(ABORT,'credential request identity is immutable'); END;
--> statement-breakpoint
CREATE TRIGGER merchant_config_changes_immutable BEFORE UPDATE ON merchant_config_changes
BEGIN SELECT RAISE(ABORT,'configuration change is immutable'); END;
--> statement-breakpoint
CREATE TRIGGER merchant_config_changes_no_delete BEFORE DELETE ON merchant_config_changes
BEGIN SELECT RAISE(ABORT,'configuration change is immutable'); END;
--> statement-breakpoint
CREATE TRIGGER merchant_config_changes_no_replace BEFORE INSERT ON merchant_config_changes
WHEN EXISTS(SELECT 1 FROM merchant_config_changes WHERE id=NEW.id OR (merchant_id=NEW.merchant_id AND request_id=NEW.request_id))
BEGIN SELECT RAISE(ABORT,'configuration change is immutable'); END;
--> statement-breakpoint
CREATE TRIGGER payment_identity_corrections_insert_guard BEFORE INSERT ON payment_identity_corrections
WHEN NEW.version!=COALESCE((SELECT MAX(version)+1 FROM payment_identity_corrections WHERE task_id=NEW.task_id),1)
 OR NOT EXISTS(
 SELECT 1 FROM payment_tasks p JOIN merchants m ON m.id=p.merchant_id
 JOIN merchant_credentials c ON c.merchant_id=m.id AND c.version=m.credential_version
 WHERE p.id=NEW.task_id AND p.source='claim' AND p.mode='real' AND p.recovery_policy='claim_same_order_v1'
 AND p.status!='confirmed' AND p.confirmed_at IS NULL AND p.unknown_outcome=0
 AND p.external_order_id IS NULL AND p.order_observed_at IS NULL AND p.send_acknowledged_at IS NULL
 AND COALESCE(p.send_block_reason,'')!='conflict' AND m.lease_token IS NULL
 AND NOT EXISTS(SELECT 1 FROM payment_attempts a WHERE a.task_id=p.id AND (a.outcome='started' OR a.finished_at IS NULL))
 AND m.version=NEW.merchant_version AND m.client_id=NEW.corrected_client_id
 AND c.version=NEW.credential_version AND c.client_id=m.client_id AND c.verification_status='passed'
 AND NEW.original_client_id=COALESCE((SELECT corrected_client_id FROM payment_identity_corrections WHERE task_id=p.id ORDER BY version DESC LIMIT 1),p.client_id)
 AND NEW.original_parameter_digest=COALESCE((SELECT corrected_parameter_digest FROM payment_identity_corrections WHERE task_id=p.id ORDER BY version DESC LIMIT 1),p.parameter_digest)
 AND NEW.corrected_client_id!=NEW.original_client_id
 AND length(NEW.corrected_parameter_digest)=64 AND NEW.corrected_parameter_digest NOT GLOB '*[^0-9a-f]*'
 AND ((NEW.evidence='never_sent' AND p.attempt_count=0 AND p.first_send_at IS NULL
       AND NOT EXISTS(SELECT 1 FROM payment_attempts a WHERE a.task_id=p.id AND a.operation='send'))
   OR (NEW.evidence='rejected_no_order' AND p.attempt_count>0
       AND p.attempt_count=(SELECT COUNT(*) FROM payment_attempts a WHERE a.task_id=p.id AND a.operation='send' AND a.purpose='recovery')
       AND NOT EXISTS(SELECT 1 FROM payment_attempts a WHERE a.task_id=p.id AND a.operation='send' AND (a.no_order_evidence IS NOT 'protocol_rejection_v1' OR a.outcome!='rejected' OR a.finished_at IS NULL))))
 )
BEGIN SELECT RAISE(ABORT,'unsafe payment identity correction'); END;
--> statement-breakpoint
CREATE TRIGGER payment_identity_corrections_immutable BEFORE UPDATE ON payment_identity_corrections
BEGIN SELECT RAISE(ABORT,'payment identity correction is immutable'); END;
--> statement-breakpoint
CREATE TRIGGER payment_identity_corrections_no_delete BEFORE DELETE ON payment_identity_corrections
BEGIN SELECT RAISE(ABORT,'payment identity correction is immutable'); END;
--> statement-breakpoint
CREATE TRIGGER payment_identity_corrections_no_replace BEFORE INSERT ON payment_identity_corrections
WHEN EXISTS(SELECT 1 FROM payment_identity_corrections WHERE id=NEW.id OR (task_id=NEW.task_id AND version=NEW.version))
BEGIN SELECT RAISE(ABORT,'payment identity correction is immutable'); END;
--> statement-breakpoint
CREATE TRIGGER payment_identity_corrections_invalidate AFTER INSERT ON payment_identity_corrections
BEGIN UPDATE payment_tasks SET recovery_version=recovery_version+1,queried_send_count=NULL,queried_recovery_version=NULL,updated_at=NEW.created_at WHERE id=NEW.task_id; END;
--> statement-breakpoint
CREATE TRIGGER payment_attempts_client_immutable BEFORE UPDATE ON payment_attempts
WHEN NEW.client_id IS NOT OLD.client_id OR NEW.identity_correction_version IS NOT OLD.identity_correction_version
 OR (OLD.no_order_evidence IS NOT NULL AND NEW.no_order_evidence IS NOT OLD.no_order_evidence)
 OR (NEW.no_order_evidence IS NOT NULL AND (NEW.no_order_evidence!='protocol_rejection_v1' OR NEW.operation!='send' OR NEW.outcome!='rejected' OR NEW.finished_at IS NULL OR NEW.http_status IS NULL OR NEW.http_status NOT IN (400,401)))
BEGIN SELECT RAISE(ABORT,'payment attempt client identity is immutable'); END;

--> statement-breakpoint
CREATE TRIGGER payment_attempts_evidence_insert BEFORE INSERT ON payment_attempts
WHEN NEW.no_order_evidence IS NOT NULL AND (NEW.no_order_evidence!='protocol_rejection_v1' OR NEW.operation!='send' OR NEW.outcome!='rejected' OR NEW.finished_at IS NULL OR NEW.http_status IS NULL OR NEW.http_status NOT IN (400,401))
BEGIN SELECT RAISE(ABORT,'invalid no-order evidence'); END;
