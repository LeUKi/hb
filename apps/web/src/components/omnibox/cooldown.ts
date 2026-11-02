import { useAttemptCooldown } from "../../lib/attempt-cooldown";
import { useSessionUser } from "../../lib/session";

/**
 * Whole seconds left of the account's attempt cooldown (shared by the start
 * page and every 红包, set by the server). It changes exactly on the second.
 */
export function useCooldownSeconds() {
  const user = useSessionUser();
  return useAttemptCooldown(user?.id ?? null).seconds;
}
