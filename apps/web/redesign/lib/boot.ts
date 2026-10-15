import { useSyncExternalStore } from "react";

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
