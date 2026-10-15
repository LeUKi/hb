-- 青春版 is retired (docs/redesign/06-production.md §1). Under the new code a
-- LiteAuth session would carry full rights, so those sessions go in the same
-- release; their owners sign in again with Linux DO Connect. Run this before
-- the new Workers are deployed.
DELETE FROM sessions WHERE login_provider='liteauth';--> statement-breakpoint
-- Pending LiteAuth logins and account upgrades can no longer complete.
DELETE FROM oauth_attempts WHERE login_provider='liteauth' OR expected_user_id IS NOT NULL;--> statement-breakpoint
-- The previous release reads this switch: keep LiteAuth closed if it ever
-- comes back in a rollback.
UPDATE login_settings
SET liteauth_enabled=0, version=version+1,
  updated_at=CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER),
  updated_by_user_id=NULL
WHERE id='global' AND liteauth_enabled=1;--> statement-breakpoint
DROP TRIGGER IF EXISTS users_official_connect_monotonic;--> statement-breakpoint
DROP TRIGGER IF EXISTS users_official_connect_insert_valid;--> statement-breakpoint
DROP TRIGGER IF EXISTS users_official_connect_update_valid;--> statement-breakpoint
DROP TRIGGER IF EXISTS sessions_record_official_connect;
-- users.official_connect_verified, the login_provider / PKCE / upgrade columns
-- and the login_settings tables are no longer read. They stay one release for
-- rollback and are dropped by a later migration (the Drizzle schema already
-- leaves them out, so the next generated migration drops them).
