import {
  useEffect,
  useLayoutEffect,
  useState,
  useSyncExternalStore,
} from "react";

type BootStage = "script" | "identity" | "frame";

type BootApi = {
  done: boolean;
  mark(stage: BootStage): void;
  fail(reason?: string): void;
  onDone(callback: () => void): void;
};

declare global {
  interface Window {
    hbBoot?: BootApi;
  }
}

/** Reports a milestone to the inline loader in index.html (no-op without it). */
export function markBoot(stage: BootStage) {
  window.hbBoot?.mark(stage);
}

export function failBoot(reason: string) {
  window.hbBoot?.fail(reason);
}

let bootDone = window.hbBoot?.done ?? true;
const listeners = new Set<() => void>();
window.hbBoot?.onDone(() => {
  bootDone = true;
  for (const listener of listeners) listener();
});

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** True once the loader hands over; drives the window launch animation. */
export function useBootDone() {
  return useSyncExternalStore(subscribe, () => bootDone);
}

/** The longest the loader waits for the identity check (02 §8). */
const identityWait = 8000;

/**
 * Feeds the loader's last two milestones: the identity check settling (a
 * failure counts: the bar then offers its own retry), then the first frame
 * after it. A check that takes longer than 8 seconds stops holding the
 * loader; the bar says it is still checking.
 */
export function useBootMilestones(identitySettled: boolean) {
  const [waitedOut, setWaitedOut] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setWaitedOut(true), identityWait);
    return () => clearTimeout(timer);
  }, []);
  const settled = identitySettled || waitedOut;
  useEffect(() => {
    if (settled) markBoot("identity");
  }, [settled]);
  useLayoutEffect(() => {
    if (!settled) return;
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
  }, [settled]);
}
