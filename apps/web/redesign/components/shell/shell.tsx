import { useAtom, useAtomValue, useSetAtom } from "jotai";
import { MotionConfig } from "motion/react";
import { useEffect, useLayoutEffect, useRef } from "react";
import { identityLatency } from "../../fixtures/session";
import { markBoot } from "../../lib/boot";
import { useReducedMotionPref } from "../../lib/motion";
import {
  identityKindAtom,
  intentAtom,
  motionPrefAtom,
  resultPasswords,
  sessionReadyAtom,
  slowBootAtom,
} from "../../lib/store";
import { DevToolbar } from "../dev/dev-toolbar";
import {
  editDraftAtom,
  messageAtom,
  scopeAtom,
  startDraftAtom,
  unconfirmedAtom,
} from "../omnibox/state";
import { AppWindow } from "./app-window";
import { SlotProvider } from "./slots";

/** Simulated identity check feeding the boot loader's last milestones. */
function useSessionBoot() {
  const [ready, setReady] = useAtom(sessionReadyAtom);
  const slow = useAtomValue(slowBootAtom);
  useEffect(() => {
    if (ready) return;
    const timer = setTimeout(() => {
      setReady(true);
      markBoot("identity");
    }, identityLatency(slow));
    return () => clearTimeout(timer);
  }, [ready, setReady, slow]);
  useLayoutEffect(() => {
    if (!ready) return;
    // Two frames after the first commit; a timer covers tabs that do not paint.
    let second = 0;
    const first = requestAnimationFrame(() => {
      second = requestAnimationFrame(() => markBoot("frame"));
    });
    const fallback = setTimeout(() => markBoot("frame"), 300);
    return () => {
      cancelAnimationFrame(first);
      cancelAnimationFrame(second);
      clearTimeout(fallback);
    };
  }, [ready]);
}

/**
 * Switching identity (or signing out) drops what was typed and the 口令
 * behind a result list. The /🔑/ results themselves stay their owner's
 * (as on the server): another account cannot open them, the owner can.
 */
function useIdentityReset() {
  const identity = useAtomValue(identityKindAtom);
  const previous = useRef(identity);
  const setMessage = useSetAtom(messageAtom);
  const setUnconfirmed = useSetAtom(unconfirmedAtom);
  const setScope = useSetAtom(scopeAtom);
  const setEditDraft = useSetAtom(editDraftAtom);
  const setStartDraft = useSetAtom(startDraftAtom);
  const setIntent = useSetAtom(intentAtom);
  useEffect(() => {
    if (previous.current === identity) return;
    previous.current = identity;
    setMessage(null);
    setUnconfirmed({ lookup: null, claims: {} });
    setScope(null);
    setEditDraft("");
    setStartDraft("");
    setIntent(null);
    resultPasswords.clear();
  }, [
    identity,
    setEditDraft,
    setIntent,
    setMessage,
    setScope,
    setStartDraft,
    setUnconfirmed,
  ]);
}

export function Shell() {
  const motionPref = useAtomValue(motionPrefAtom);
  const reduced = useReducedMotionPref();
  useSessionBoot();
  useIdentityReset();
  return (
    <MotionConfig reducedMotion={motionPref === "reduce" ? "always" : "user"}>
      <SlotProvider>
        <div
          data-motion={reduced ? "reduce" : undefined}
          className="desktop-bg fixed inset-0 grid place-items-center overflow-hidden"
        >
          <div aria-hidden="true" className="desktop-glows">
            <span className="desktop-glow desktop-glow-gold" />
            <span className="desktop-glow desktop-glow-coral" />
            <span className="desktop-glow desktop-glow-ember" />
          </div>
          <AppWindow />
          <DevToolbar />
        </div>
      </SlotProvider>
    </MotionConfig>
  );
}
