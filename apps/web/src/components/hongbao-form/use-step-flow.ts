import { useLocation, useRouter } from "@tanstack/react-router";
import { useIsPresent } from "motion/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { steps } from "./steps";

declare module "@tanstack/history" {
  interface HistoryState {
    /** 发红包: the step shown, 2–4 (absent: the first). */
    formStep?: number;
    /** 发红包: the history index of the first step's entry. */
    formStepBase?: number;
  }
}

/**
 * /new's steps as history entries: 下一步 pushes one, so back and forward
 * walk the steps (the leave guard only asks when the path changes, which
 * stepping never does). `openable` is the furthest step that may show:
 * every step before it is answered. The form lives in React state and
 * starts fresh with the page, so step entries a visit left behind (after a
 * reload, or back from the new 红包) are walked back on arrival.
 */
export function useLinearSteps(openable: number, enabled: boolean) {
  const router = useRouter();
  const inState = useLocation({
    select: (location) => location.state.formStep ?? 1,
  });
  const index = useLocation({
    select: (location) => location.state.__TSR_index,
  });
  const [reached, setReached] = useState(1);
  // Leaving (after a save), the page keeps the step it showed: the address
  // it reads is already the next page's.
  const present = useIsPresent();
  const live = Math.max(1, Math.min(inState, reached, openable));
  const shown = useRef(live);
  if (present) shown.current = live;
  const current = shown.current;
  const active = enabled && present;

  // One history operation at a time (go is asynchronous; TanStack merges
  // operations sent in the same tick).
  const pending = useRef(false);
  const lastIndex = useRef(index);
  if (lastIndex.current !== index) {
    lastIndex.current = index;
    pending.current = false;
  }

  const strip = useCallback(() => {
    const { state } = router.history.location;
    const {
      __TSR_index,
      __TSR_key,
      key,
      formStep,
      formStepBase,
      panel,
      omnibox,
      overlayBase,
      ...rest
    } = state;
    return { state, rest };
  }, [router]);

  /** Show step `to` by walking the history there, or by rewriting it. */
  const walk = useCallback(
    (to: number) => {
      const { state, rest } = strip();
      const at = state.formStep ?? 1;
      if (to === at || pending.current) return;
      const base = state.formStepBase;
      if (base !== undefined && state.__TSR_index - base === at - 1) {
        pending.current = true;
        router.history.go(to - at);
      } else {
        const { href } = router.history.location;
        router.history.replace(
          href,
          to > 1 ? { ...rest, formStep: to, formStepBase: base } : rest,
        );
      }
    },
    [router, strip],
  );

  // Arrival: a fresh form starts at the first step.
  const arrived = useRef(false);
  useEffect(() => {
    if (!active || arrived.current) return;
    arrived.current = true;
    const { state } = router.history.location;
    if ((state.formStep ?? 1) > 1 || state.panel === "settings") {
      const base = state.formStepBase;
      if (base !== undefined && state.__TSR_index > base) {
        pending.current = true;
        router.history.go(base - state.__TSR_index);
      } else {
        const { href } = router.history.location;
        router.history.replace(href, strip().rest);
      }
    }
  }, [active, router, strip]);

  // A step that can no longer show (an earlier answer was undone, then
  // forward was pressed) walks the history back to what is shown.
  useEffect(() => {
    if (!active || !arrived.current || pending.current) return;
    if (inState !== current) walk(current);
  });

  /** 下一步 (the caller checked the step). */
  const next = useCallback(() => {
    if (pending.current) return;
    const { state, rest } = strip();
    const at = state.formStep ?? 1;
    if (at >= steps.length) return;
    setReached((value) => Math.max(value, at + 1));
    const { href } = router.history.location;
    router.history.push(href, {
      ...rest,
      formStep: at + 1,
      formStepBase: state.formStepBase ?? state.__TSR_index,
    });
  }, [router, strip]);

  return {
    current,
    next,
    /** Back to an earlier step: its strip was pressed. */
    back: useCallback(
      (to: number) => {
        if (to < current) walk(to);
      },
      [current, walk],
    ),
    /** An answer changed what follows (another 玩法): answer it again. */
    restart: useCallback(() => setReached(1), []),
  };
}
