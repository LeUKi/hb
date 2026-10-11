import { createContext, useContext } from "react";
import type { useLogout } from "../../lib/auth";
export const SessionActionsContext = createContext<ReturnType<
  typeof useLogout
> | null>(null);
export function useAppLogout() {
  const logout = useContext(SessionActionsContext);
  if (!logout) throw new Error("Session actions provider is missing");
  return logout;
}
