-- 打赏 (docs/tip-design.md, 2026-11-05): 打赏卡 and the tips made through
-- them, and the two site switches (打赏, 免密打赏), both off.
CREATE TABLE `tip_cards` (
	`id` text PRIMARY KEY NOT NULL,
	`code` text NOT NULL,
	`owner_id` text NOT NULL,
	`name` text NOT NULL,
	`style` text NOT NULL,
	`palette` text NOT NULL,
	`prompt` text DEFAULT '' NOT NULL,
	`amounts` text NOT NULL,
	`default_index` integer DEFAULT 0 NOT NULL,
	`allow_other` integer DEFAULT false NOT NULL,
	`goal_minor` integer,
	`goal_since` integer,
	`show_recent` integer DEFAULT false NOT NULL,
	`show_top` integer DEFAULT false NOT NULL,
	`link_kind` text DEFAULT 'none' NOT NULL,
	`link_topic_id` text,
	`link_title` text,
	`link_url` text,
	`version` integer DEFAULT 1 NOT NULL,
	`stopped_at` integer,
	`stopped_by_admin_id` text,
	`stop_reason` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`owner_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "tip_cards_valid" CHECK(length("tip_cards"."code") BETWEEN 4 AND 16 AND "tip_cards"."default_index" BETWEEN 0 AND 3
        AND ("tip_cards"."goal_minor" IS NULL) = ("tip_cards"."goal_since" IS NULL)
        AND ("tip_cards"."goal_minor" IS NULL OR ("tip_cards"."style" = 'standard' AND "tip_cards"."goal_minor" BETWEEN 100 AND 10000000))
        AND ("tip_cards"."link_kind" = 'topic') = ("tip_cards"."link_topic_id" IS NOT NULL)
        AND "tip_cards"."version" >= 1)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tip_cards_code_unique` ON `tip_cards` (`code`);--> statement-breakpoint
CREATE INDEX `tip_cards_owner_idx` ON `tip_cards` (`owner_id`,`created_at`,`id`);--> statement-breakpoint
CREATE TABLE `tips` (
	`id` text PRIMARY KEY NOT NULL,
	`card_id` text NOT NULL,
	`card_version` integer NOT NULL,
	`owner_id` text NOT NULL,
	`tipper_id` text,
	`amount_minor` integer NOT NULL,
	`method` text NOT NULL,
	`message` text,
	`message_hidden` integer DEFAULT false NOT NULL,
	`status` text NOT NULL,
	`not_sent_reason` text,
	`via` text NOT NULL,
	`request_id` text NOT NULL,
	`request_digest` text NOT NULL,
	`merchant_id` text,
	`client_id` text,
	`credential_version` integer,
	`business_no` text,
	`order_name` text,
	`return_url` text,
	`external_order_id` text,
	`flag` text,
	`submitted_at` integer,
	`last_checked_at` integer,
	`last_check_result` text,
	`check_claimed_at` integer DEFAULT 0 NOT NULL,
	`transfer_id` text,
	`payment_task_id` text,
	`created_at` integer NOT NULL,
	`done_at` integer,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`card_id`) REFERENCES `tip_cards`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`owner_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`tipper_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`merchant_id`) REFERENCES `merchants`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`transfer_id`) REFERENCES `balance_transfers`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "tips_valid" CHECK("tips"."amount_minor" BETWEEN 100 AND 200000
        AND ("tips"."tipper_id" IS NULL OR "tips"."tipper_id" <> "tips"."owner_id")
        AND ("tips"."message" IS NULL OR length("tips"."message") BETWEEN 1 AND 50)
        AND ("tips"."status" = 'done') = ("tips"."done_at" IS NOT NULL)
        AND ("tips"."method" <> 'checkout' OR ("tips"."business_no" IS NOT NULL AND "tips"."merchant_id" IS NOT NULL AND "tips"."status" IN ('pending','done','unpaid')))
        AND ("tips"."method" <> 'balance' OR ("tips"."transfer_id" IS NOT NULL AND "tips"."tipper_id" IS NOT NULL AND "tips"."status" = 'done'))
        AND ("tips"."method" <> 'merchant' OR ("tips"."tipper_id" IS NOT NULL AND "tips"."status" IN ('sending','done','not_sent'))))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tips_request_unique` ON `tips` (`tipper_id`,`request_id`) WHERE "tips"."tipper_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `tips_guest_request_unique` ON `tips` (`request_id`) WHERE "tips"."tipper_id" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `tips_business_no_unique` ON `tips` (`business_no`) WHERE "tips"."business_no" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `tips_transfer_unique` ON `tips` (`transfer_id`) WHERE "tips"."transfer_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX `tips_card_done_idx` ON `tips` (`card_id`,`status`,`done_at`);--> statement-breakpoint
CREATE INDEX `tips_owner_time_idx` ON `tips` (`owner_id`,`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `tips_tipper_time_idx` ON `tips` (`tipper_id`,`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `tips_status_time_idx` ON `tips` (`status`,`created_at`);--> statement-breakpoint
ALTER TABLE `balance_settings` ADD `tip_enabled` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `balance_settings` ADD `tip_password_free_enabled` integer DEFAULT false NOT NULL;
--> statement-breakpoint
-- A tip only moves forward: a Credit 站 one from 等付款 to 已打赏 or 没付
-- (a late payment still turns 没付 into 已打赏); one from a 商户 from
-- 发放中 to 已打赏 or 没发出. 已打赏 stays.
CREATE TRIGGER `tips_status_valid` BEFORE UPDATE OF `status` ON `tips`
WHEN NOT (OLD.status = NEW.status
  OR (OLD.status = 'pending' AND NEW.status IN ('done','unpaid'))
  OR (OLD.status = 'unpaid' AND NEW.status = 'done')
  OR (OLD.status = 'sending' AND NEW.status IN ('done','not_sent')))
BEGIN SELECT RAISE(ABORT, 'TIP_STATUS_INVALID'); END;--> statement-breakpoint
-- Who, how much, how and through what are fixed once written.
CREATE TRIGGER `tips_identity_immutable` BEFORE UPDATE ON `tips`
WHEN NEW.id IS NOT OLD.id OR NEW.card_id IS NOT OLD.card_id OR NEW.card_version IS NOT OLD.card_version
  OR NEW.owner_id IS NOT OLD.owner_id OR NEW.tipper_id IS NOT OLD.tipper_id OR NEW.amount_minor IS NOT OLD.amount_minor
  OR NEW.method IS NOT OLD.method OR NEW.request_id IS NOT OLD.request_id OR NEW.request_digest IS NOT OLD.request_digest
  OR NEW.business_no IS NOT OLD.business_no OR NEW.merchant_id IS NOT OLD.merchant_id OR NEW.client_id IS NOT OLD.client_id
  OR NEW.credential_version IS NOT OLD.credential_version OR NEW.transfer_id IS NOT OLD.transfer_id
  OR (OLD.payment_task_id IS NOT NULL AND NEW.payment_task_id IS NOT OLD.payment_task_id)
  OR NEW.created_at IS NOT OLD.created_at
BEGIN SELECT RAISE(ABORT, 'TIP_IMMUTABLE'); END;--> statement-breakpoint
CREATE TRIGGER `tips_permanent` BEFORE DELETE ON `tips`
BEGIN SELECT RAISE(ABORT, 'TIP_PERMANENT'); END;--> statement-breakpoint
-- A card is stopped, never deleted: its tips keep pointing at it.
CREATE TRIGGER `tip_cards_permanent` BEFORE DELETE ON `tip_cards`
BEGIN SELECT RAISE(ABORT, 'TIP_CARD_PERMANENT'); END;--> statement-breakpoint
CREATE TRIGGER `tip_cards_identity_immutable` BEFORE UPDATE ON `tip_cards`
WHEN NEW.id IS NOT OLD.id OR NEW.code IS NOT OLD.code OR NEW.owner_id IS NOT OLD.owner_id OR NEW.created_at IS NOT OLD.created_at
BEGIN SELECT RAISE(ABORT, 'TIP_CARD_IMMUTABLE'); END;
