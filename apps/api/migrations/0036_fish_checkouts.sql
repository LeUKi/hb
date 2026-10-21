CREATE TABLE `balance_checkouts` (
	`id` text PRIMARY KEY NOT NULL,
	`from_user_id` text NOT NULL,
	`to_user_id` text NOT NULL,
	`to_username` text NOT NULL,
	`to_linux_do_id` text NOT NULL,
	`merchant_id` text NOT NULL,
	`client_id` text NOT NULL,
	`credential_version` integer NOT NULL,
	`business_no` text NOT NULL,
	`amount_minor` integer NOT NULL,
	`remark` text,
	`order_name` text NOT NULL,
	`return_url` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`flag` text,
	`external_order_id` text,
	`request_id` text NOT NULL,
	`request_digest` text NOT NULL,
	`created_at` integer NOT NULL,
	`submitted_at` integer,
	`paid_at` integer,
	`last_checked_at` integer,
	`last_check_result` text,
	`check_claimed_at` integer DEFAULT 0 NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`from_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`to_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`merchant_id`) REFERENCES `merchants`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "balance_checkouts_valid" CHECK("balance_checkouts"."amount_minor" BETWEEN 100 AND 200000 AND "balance_checkouts"."from_user_id" <> "balance_checkouts"."to_user_id"
        AND "balance_checkouts"."status" IN ('pending','unpaid','paid') AND ("balance_checkouts"."flag" IS NULL OR "balance_checkouts"."flag" IN ('mismatch','reversed'))
        AND ("balance_checkouts"."status" = 'paid') = ("balance_checkouts"."paid_at" IS NOT NULL)
        AND ("balance_checkouts"."remark" IS NULL OR length("balance_checkouts"."remark") BETWEEN 1 AND 64))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `balance_checkouts_business_no_unique` ON `balance_checkouts` (`business_no`);--> statement-breakpoint
CREATE UNIQUE INDEX `balance_checkouts_request_unique` ON `balance_checkouts` (`from_user_id`,`request_id`);--> statement-breakpoint
CREATE INDEX `balance_checkouts_from_time_idx` ON `balance_checkouts` (`from_user_id`,`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `balance_checkouts_to_status_time_idx` ON `balance_checkouts` (`to_user_id`,`status`,`created_at`,`id`);--> statement-breakpoint
-- Made once: only how it stands changes (status, flag, Credit 站's order
-- number once known, and the times of its checks). Paid is final.
CREATE TRIGGER balance_checkouts_identity_immutable
BEFORE UPDATE ON balance_checkouts
WHEN NEW.id IS NOT OLD.id OR NEW.from_user_id IS NOT OLD.from_user_id OR NEW.to_user_id IS NOT OLD.to_user_id
  OR NEW.to_username IS NOT OLD.to_username OR NEW.to_linux_do_id IS NOT OLD.to_linux_do_id
  OR NEW.merchant_id IS NOT OLD.merchant_id OR NEW.client_id IS NOT OLD.client_id
  OR NEW.credential_version IS NOT OLD.credential_version OR NEW.business_no IS NOT OLD.business_no
  OR NEW.amount_minor IS NOT OLD.amount_minor OR NEW.remark IS NOT OLD.remark
  OR NEW.order_name IS NOT OLD.order_name OR NEW.return_url IS NOT OLD.return_url
  OR NEW.request_id IS NOT OLD.request_id OR NEW.request_digest IS NOT OLD.request_digest
  OR NEW.created_at IS NOT OLD.created_at
  OR (OLD.external_order_id IS NOT NULL AND NEW.external_order_id IS NOT OLD.external_order_id)
BEGIN
  SELECT RAISE(ABORT, 'checkout identity immutable');
END;--> statement-breakpoint
CREATE TRIGGER balance_checkouts_status_valid
BEFORE UPDATE OF status ON balance_checkouts
WHEN NEW.status IS NOT OLD.status AND NOT (
  (OLD.status = 'pending' AND NEW.status IN ('unpaid','paid'))
  OR (OLD.status = 'unpaid' AND NEW.status = 'paid'))
BEGIN
  SELECT RAISE(ABORT, 'checkout status only moves forward');
END;--> statement-breakpoint
CREATE TRIGGER balance_checkouts_insert_valid
BEFORE INSERT ON balance_checkouts
WHEN NEW.status <> 'pending' OR NEW.paid_at IS NOT NULL OR NEW.flag IS NOT NULL OR NEW.external_order_id IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'checkout starts pending');
END;--> statement-breakpoint
CREATE TRIGGER balance_checkouts_permanent
BEFORE DELETE ON balance_checkouts
BEGIN
  SELECT RAISE(ABORT, 'checkouts are permanent');
END;
