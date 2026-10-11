-- An official session is durable evidence of a successful Connect login.
-- This covers callbacks from the previous API while the new API is deployed.
UPDATE users SET official_connect_verified=1
WHERE provider='linux_do' AND official_connect_verified=0
  AND EXISTS (
    SELECT 1 FROM sessions
    WHERE sessions.user_id=users.id AND sessions.login_provider='connect'
  );--> statement-breakpoint
CREATE TRIGGER sessions_record_official_connect
AFTER INSERT ON sessions
WHEN NEW.login_provider='connect'
BEGIN
  UPDATE users SET official_connect_verified=1
  WHERE id=NEW.user_id AND provider='linux_do' AND official_connect_verified=0;
END;
