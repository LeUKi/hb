CREATE TABLE `code_judge_people` (
	`activity_id` text NOT NULL,
	`user_id` text NOT NULL,
	`judged` integer NOT NULL,
	`claimed` integer NOT NULL,
	`paid_minor` integer,
	`first_at` integer NOT NULL,
	`last_at` integer NOT NULL,
	PRIMARY KEY(`activity_id`, `user_id`),
	FOREIGN KEY (`activity_id`) REFERENCES `activities`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "code_judge_people_shape" CHECK(typeof("code_judge_people"."judged") = 'integer' AND "code_judge_people"."judged" >= 1
        AND (("code_judge_people"."claimed" = 1 AND typeof("code_judge_people"."paid_minor") = 'integer' AND "code_judge_people"."paid_minor" > 0)
          OR ("code_judge_people"."claimed" = 0 AND "code_judge_people"."paid_minor" IS NULL))
        AND typeof("code_judge_people"."first_at") = 'integer' AND "code_judge_people"."last_at" >= "code_judge_people"."first_at")
);
--> statement-breakpoint
CREATE INDEX `code_judge_people_recent_idx` ON `code_judge_people` (`activity_id`,`last_at`,`user_id`);--> statement-breakpoint
CREATE INDEX `code_judge_people_most_idx` ON `code_judge_people` (`activity_id`,`judged`,`last_at`,`user_id`);--> statement-breakpoint
CREATE INDEX `code_judge_people_claimed_idx` ON `code_judge_people` (`activity_id`,`claimed`,`last_at`,`user_id`);--> statement-breakpoint
CREATE INDEX `code_judgments_claimed_idx` ON `code_judgments` (`activity_id`,`sequence`) WHERE "code_judgments"."ok" = 1;--> statement-breakpoint
-- 判定记录 · 按人 (docs/judge-records-design.md §4): the 红包 already
-- judged, counted once from their judgments; claims.ts keeps it after.
INSERT INTO `code_judge_people` (`activity_id`, `user_id`, `judged`, `claimed`, `paid_minor`, `first_at`, `last_at`)
SELECT `activity_id`, `user_id`, COUNT(*), MAX(`ok`), MAX(`paid_minor`), MIN(`judged_at`), MAX(`judged_at`)
FROM `code_judgments` GROUP BY `activity_id`, `user_id`;
