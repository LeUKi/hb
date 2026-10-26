import { useQueryClient } from "@tanstack/react-query";
import { useSetAtom } from "jotai";
import { MotionConfig } from "motion/react";
import { useEffect, useRef } from "react";
import { clearAttemptOperations } from "../../lib/attempt-history";
import { sessionQueryKey } from "../../lib/auth";
import { useBootMilestones } from "../../lib/boot";
import { exchangeContextAtom } from "../../lib/discovery";
import { useMaintenanceRecovery } from "../../lib/maintenance";
import { useReducedMotionPref } from "../../lib/motion";
import {
  redemptionIntentAtom,
  rewardAnimationAtom,
} from "../../lib/redemption-intent";
import { useIdentity } from "../../lib/session";
import {
  editDraftAtom,
  messageAtom,
  scopeAtom,
  startDraftAtom,
  unconfirmedAtom,
} from "../omnibox/state";
import { AppWindow } from "./app-window";
import { AttachedPageLayout } from "./attached-page";
import { SlotProvider } from "./slots";

/** Queries that hold no account's data: kept across sign-in and sign-out. */
const sharedQuery = (key: readonly unknown[]) =>
  key[0] === "api-health" || key[0] === "auth";

/** Queries only an account sees, dropped when it signs out. */
const privatePrefixes = [
  "activity-private",
  "claim-private",
  "redemption-private",
  "merchant-private",
];

/**
 * Switching account (or signing out) drops what was typed, the 口令 behind
 * a lookup and every query that was the previous account's; the new one
 * reads its own. Signing out also drops the private queries outright.
 */
function useIdentityReset() {
  const { ready, user } = useIdentity();
  const queryClient = useQueryClient();
  const identity = ready ? (user?.id ?? null) : undefined;
  const previous = useRef<string | null | undefined>(undefined);
  const setMessage = useSetAtom(messageAtom);
  const setUnconfirmed = useSetAtom(unconfirmedAtom);
  const setScope = useSetAtom(scopeAtom);
  const setEditDraft = useSetAtom(editDraftAtom);
  const setStartDraft = useSetAtom(startDraftAtom);
  const setIntent = useSetAtom(redemptionIntentAtom);
  const setRewardAnimation = useSetAtom(rewardAnimationAtom);
  const setExchange = useSetAtom(exchangeContextAtom);
  useEffect(() => {
    if (identity === undefined) return;
    const before = previous.current;
    previous.current = identity;
    if (before === undefined || before === identity) return;
    setMessage(null);
    setUnconfirmed({ lookup: null, claims: {} });
    setScope(null);
    setEditDraft("");
    setStartDraft("");
    setIntent(null);
    setRewardAnimation(null);
    setExchange(null);
    if (before) clearAttemptOperations(before);
    queryClient.getMutationCache().clear();
    const accountData = (key: readonly unknown[]) => !sharedQuery(key);
    void queryClient
      .cancelQueries({ predicate: (query) => accountData(query.queryKey) })
      .then(async () => {
        queryClient.removeQueries({
          predicate: (query) =>
            accountData(query.queryKey) && query.getObserversCount() === 0,
        });
        await queryClient.resetQueries({
          predicate: (query) => accountData(query.queryKey),
        });
      });
    if (identity === null) {
      const signedOutOnly = (key: readonly unknown[]) =>
        privatePrefixes.includes(String(key[0])) ||
        (key[0] === "password-private" && key[1] !== "guest");
      void queryClient
        .cancelQueries({ predicate: (query) => signedOutOnly(query.queryKey) })
        .then(() =>
          queryClient.removeQueries({
            predicate: (query) => signedOutOnly(query.queryKey),
          }),
        );
    }
  }, [
    identity,
    queryClient,
    setEditDraft,
    setExchange,
    setIntent,
    setMessage,
    setRewardAnimation,
    setScope,
    setStartDraft,
    setUnconfirmed,
  ]);
  // Admin data never outlives the admin's own session.
  const admin = user?.isAdmin ?? false;
  useEffect(() => {
    if (!ready || admin) return;
    void queryClient
      .cancelQueries({ queryKey: ["admin-private"] })
      .then(() => queryClient.removeQueries({ queryKey: ["admin-private"] }));
  }, [admin, queryClient, ready]);
}

/** A session changed in another tab shows up as soon as this one is back. */
function useSessionRefresh() {
  const queryClient = useQueryClient();
  useEffect(() => {
    const refresh = () => {
      if (document.visibilityState === "hidden") return;
      void queryClient.invalidateQueries(
        { queryKey: sessionQueryKey },
        { cancelRefetch: false },
      );
    };
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [queryClient]);
}

export function Shell() {
  const reduced = useReducedMotionPref();
  useBootMilestones(useIdentity().ready);
  useIdentityReset();
  useSessionRefresh();
  useMaintenanceRecovery();
  return (
    <MotionConfig reducedMotion="user">
      <SlotProvider>
        <div
          data-desktop
          data-motion={reduced ? "reduce" : undefined}
          className="desktop-bg fixed inset-0 grid place-items-center overflow-hidden"
        >
          <div aria-hidden="true" className="desktop-glows">
            <span className="desktop-glow desktop-glow-gold" />
            <span className="desktop-glow desktop-glow-coral" />
            <span className="desktop-glow desktop-glow-ember" />
          </div>
          <AttachedPageLayout>
            <AppWindow />
          </AttachedPageLayout>
        </div>
      </SlotProvider>
    </MotionConfig>
  );
}
