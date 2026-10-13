import { createContext, useContext } from "react";
import type { useLogout } from "../../lib/auth";
import type { ActionFeedback } from "../ui/action-feedback";
export const SessionActionsContext = createContext<
  (ReturnType<typeof useLogout> & { feedback: ActionFeedback | null }) | null
>(null);
export function useAppLogout() {
  const logout = useContext(SessionActionsContext);
  if (!logout) throw new Error("Session actions provider is missing");
  return logout;
}
