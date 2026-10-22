CREATE TABLE `activity_random_proofs` (
	`activity_id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`version` integer NOT NULL,
	`round` integer,
	`round_at` integer,
	`roster_hash` text,
	`roster_count` integer,
	`randomness` text,
	`signature` text,
	`seed` text,
	`fetched_at` integer,
	`commitment` text,
	`secret_ciphertext` text,
	`secret` text,
	`revealed_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`activity_id`) REFERENCES `activities`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "activity_random_proofs_shape" CHECK("activity_random_proofs"."version" = 2 AND (("activity_random_proofs"."kind" = 'draw' AND typeof("activity_random_proofs"."round") = 'integer' AND "activity_random_proofs"."round" > 0
        AND typeof("activity_random_proofs"."round_at") = 'integer' AND length("activity_random_proofs"."roster_hash") = 64
        AND typeof("activity_random_proofs"."roster_count") = 'integer' AND "activity_random_proofs"."roster_count" >= 0
        AND "activity_random_proofs"."commitment" IS NULL AND "activity_random_proofs"."secret_ciphertext" IS NULL AND "activity_random_proofs"."secret" IS NULL AND "activity_random_proofs"."revealed_at" IS NULL
        AND (("activity_random_proofs"."randomness" IS NULL AND "activity_random_proofs"."signature" IS NULL AND "activity_random_proofs"."seed" IS NULL AND "activity_random_proofs"."fetched_at" IS NULL)
          OR (length("activity_random_proofs"."randomness") = 64 AND length("activity_random_proofs"."signature") = 96 AND length("activity_random_proofs"."seed") = 64 AND "activity_random_proofs"."fetched_at" IS NOT NULL)))
      OR ("activity_random_proofs"."kind" = 'queue' AND length("activity_random_proofs"."commitment") = 64 AND "activity_random_proofs"."secret_ciphertext" IS NOT NULL
        AND "activity_random_proofs"."round" IS NULL AND "activity_random_proofs"."round_at" IS NULL AND "activity_random_proofs"."roster_hash" IS NULL AND "activity_random_proofs"."roster_count" IS NULL
        AND "activity_random_proofs"."randomness" IS NULL AND "activity_random_proofs"."signature" IS NULL AND "activity_random_proofs"."seed" IS NULL AND "activity_random_proofs"."fetched_at" IS NULL
        AND (("activity_random_proofs"."secret" IS NULL AND "activity_random_proofs"."revealed_at" IS NULL) OR (length("activity_random_proofs"."secret") = 64 AND "activity_random_proofs"."revealed_at" IS NOT NULL)))))
);
--> statement-breakpoint
ALTER TABLE `activities` ADD `random_version` integer;--> statement-breakpoint
-- 开奖证明 v2 (docs/draw-proof-design.md). A 红包's random version is set
-- once, when it opens; nothing before then or after can change it.
CREATE TRIGGER activities_random_version_insert_guard BEFORE INSERT ON activities
WHEN NEW.random_version IS NOT NULL
BEGIN SELECT RAISE(ABORT,'invalid_random_version'); END;
--> statement-breakpoint
CREATE TRIGGER activities_random_version_guard BEFORE UPDATE OF random_version ON activities
WHEN NEW.random_version IS NOT OLD.random_version
 AND NOT (OLD.opened_at IS NULL AND NEW.opened_at IS NOT NULL AND NEW.random_version = 2)
BEGIN SELECT RAISE(ABORT,'immutable_random_version'); END;
--> statement-breakpoint
-- A 限时开奖's proof is made at closing, for the round right after it (the
-- round's time follows from quicknet's genesis and 3 s period); a queue's
-- at opening, before anyone has claimed.
CREATE TRIGGER activity_random_proofs_insert_guard BEFORE INSERT ON activity_random_proofs
WHEN NEW.randomness IS NOT NULL OR NEW.secret IS NOT NULL
 OR NOT EXISTS(SELECT 1 FROM activities a WHERE a.id=NEW.activity_id AND a.reward_type='ldc'
   AND a.deleted_at IS NULL AND a.opened_at IS NOT NULL AND a.random_version=NEW.version
   AND ((NEW.kind='draw' AND a.draw_state='settling' AND a.draw_closed_at IS NOT NULL
       AND a.registered_count=NEW.roster_count
       AND NEW.round_at=(1692803367+(NEW.round-1)*3)*1000
       AND NEW.round_at>a.draw_closed_at AND NEW.round_at<=a.draw_closed_at+3000)
     OR (NEW.kind='queue' AND a.draw_state IS NULL AND a.claimed_count=0)))
BEGIN SELECT RAISE(ABORT,'invalid_random_proof'); END;
--> statement-breakpoint
-- Written once: a round's randomness once fetched, a queue's secret only
-- once the 红包 is over.
CREATE TRIGGER activity_random_proofs_immutable BEFORE UPDATE ON activity_random_proofs
WHEN NEW.activity_id IS NOT OLD.activity_id OR NEW.kind IS NOT OLD.kind OR NEW.version IS NOT OLD.version
 OR NEW.round IS NOT OLD.round OR NEW.round_at IS NOT OLD.round_at
 OR NEW.roster_hash IS NOT OLD.roster_hash OR NEW.roster_count IS NOT OLD.roster_count
 OR NEW.commitment IS NOT OLD.commitment OR NEW.secret_ciphertext IS NOT OLD.secret_ciphertext
 OR NEW.created_at IS NOT OLD.created_at
 OR (OLD.randomness IS NOT NULL AND (NEW.randomness IS NOT OLD.randomness OR NEW.signature IS NOT OLD.signature
   OR NEW.seed IS NOT OLD.seed OR NEW.fetched_at IS NOT OLD.fetched_at))
 OR (OLD.secret IS NOT NULL AND (NEW.secret IS NOT OLD.secret OR NEW.revealed_at IS NOT OLD.revealed_at))
 OR (OLD.secret IS NULL AND NEW.secret IS NOT NULL AND NOT EXISTS(SELECT 1 FROM activities a
   WHERE a.id=OLD.activity_id AND (a.ended_at IS NOT NULL OR a.claimed_count>=a.total_count
     OR a.deadline<=CAST((julianday('now')-2440587.5)*86400000 AS INTEGER))))
BEGIN SELECT RAISE(ABORT,'immutable_random_proof'); END;
--> statement-breakpoint
CREATE TRIGGER activity_random_proofs_no_delete BEFORE DELETE ON activity_random_proofs
BEGIN SELECT RAISE(ABORT,'immutable_random_proof'); END;
--> statement-breakpoint
-- An opened queue is the order it was sealed in (a 限时开奖's prizes come
-- with its plan instead).
CREATE TRIGGER reward_inventory_queue_update_guard BEFORE UPDATE ON reward_inventory
WHEN EXISTS(SELECT 1 FROM activities WHERE id=OLD.activity_id AND opened_at IS NOT NULL AND random_version IS NOT NULL
  AND draw_state IS NULL)
BEGIN SELECT RAISE(ABORT,'immutable_queue'); END;
--> statement-breakpoint
CREATE TRIGGER reward_inventory_queue_insert_guard BEFORE INSERT ON reward_inventory
WHEN EXISTS(SELECT 1 FROM activities WHERE id=NEW.activity_id AND opened_at IS NOT NULL AND random_version IS NOT NULL
  AND draw_state IS NULL)
BEGIN SELECT RAISE(ABORT,'immutable_queue'); END;
