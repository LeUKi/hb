ALTER TABLE `users` ADD `trust_level` integer;--> statement-breakpoint
ALTER TABLE `users` ADD `silenced` integer;--> statement-breakpoint
ALTER TABLE `users` ADD `profile_seen_at` integer;--> statement-breakpoint
-- 信任等级 as LINUX DO Connect gives it (docs/claim-scope-design.md §2).
CREATE TRIGGER users_trust_level_insert_valid BEFORE INSERT ON users
WHEN NEW.trust_level IS NOT NULL AND (typeof(NEW.trust_level)!='integer' OR NEW.trust_level NOT BETWEEN 0 AND 4)
BEGIN SELECT RAISE(ABORT,'invalid_trust_level'); END;
--> statement-breakpoint
CREATE TRIGGER users_trust_level_update_valid BEFORE UPDATE OF trust_level ON users
WHEN NEW.trust_level IS NOT NULL AND (typeof(NEW.trust_level)!='integer' OR NEW.trust_level NOT BETWEEN 0 AND 4)
BEGIN SELECT RAISE(ABORT,'invalid_trust_level'); END;
