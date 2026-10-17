import { useQueryClient } from "@tanstack/react-query";
import { atom, getDefaultStore, useAtomValue } from "jotai";
import { useEffect, useRef } from "react";

// 维护模式 (docs/d1-apac-migration.md): while the database moves, the API
// turns every request but /api/health away with 503 MAINTENANCE, before it
// does anything. The site then says 系统维护中 wherever something failed,
// asks now and then whether it is over, and reads again what failed
// meanwhile once it is (02 §9).

export const MAINTENANCE = "MAINTENANCE";

/** How often the site asks whether 维护模式 is over, while it is on screen. */
const PROBE_MS = 20_000;

/** The API's last answer was 维护模式. */
export const maintenanceAtom = atom(false);

/** What an API answer said: 维护模式, or (any other answer) not. */
export function noteMaintenance(on: boolean) {
  const store = getDefaultStore();
  if (store.get(maintenanceAtom) !== on) store.set(maintenanceAtom, on);
}

/** Whether a failed response is 维护模式's; reads a copy of its body. */
export async function isMaintenanceAnswer(response: Response) {
  if (response.status !== 503) return false;
  try {
    const body = (await response.clone().json()) as {
      error?: { code?: string };
    };
    return body?.error?.code === MAINTENANCE;
  } catch {
    return false;
  }
}

export function useMaintenance() {
  return useAtomValue(maintenanceAtom);
}

/**
 * While 维护模式 is on, asks the session endpoint again every PROBE_MS (it
 * answers 503 MAINTENANCE until the end). Any other answer ends it: every
 * query on screen that failed meanwhile, the identity check among them,
 * is read again.
 */
export function useMaintenanceRecovery() {
  const on = useMaintenance();
  const client = useQueryClient();
  const before = useRef(on);
  useEffect(() => {
    if (!on) return;
    const probe = async () => {
      if (document.visibilityState !== "visible") return;
      try {
        const response = await fetch("/api/session", { cache: "no-store" });
        if (!(await isMaintenanceAnswer(response))) noteMaintenance(false);
      } catch {
        // No answer at all: ask again next time.
      }
    };
    const timer = window.setInterval(probe, PROBE_MS);
    return () => window.clearInterval(timer);
  }, [on]);
  useEffect(() => {
    const was = before.current;
    before.current = on;
    if (was && !on)
      void client.refetchQueries({
        type: "active",
        predicate: (query) => query.state.status === "error",
      });
  }, [on, client]);
}
