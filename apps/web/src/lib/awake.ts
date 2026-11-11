import { useSyncExternalStore } from "react";

// 闲着不画 (docs/redesign/09-idle-frames.md): the page's decorative loops
// (开's sheen, the 在看 dot, the sheet's arrow, the background's glows, a
// hidden 口令's 乱码) move only while someone is here: from the last
// pointer, key, wheel, touch or scroll for AWAKE_MS, and from the page
// coming to the front. Every frame drawn under the windows' glass blurs it
// again (a whole window, every frame: measured 2026-11-11, an idle 红包 page
// at 6.9% of the GPU against 1.2% still), so a page left open draws
// nothing. What happens inside a 附带网页 does not reach here: playing a
// game in it, the loops around it stop too. :root[data-awake] is for CSS.

/** How long after the last input the page counts as awake. */
export const AWAKE_MS = 8000;

let awake = true;
let started = false;
let last = 0;
let timer: number | undefined;
const listeners = new Set<() => void>();

function set(next: boolean) {
  if (awake === next) return;
  awake = next;
  document.documentElement.toggleAttribute("data-awake", next);
  for (const listener of listeners) listener();
}

/** Sleep once AWAKE_MS have passed since the last input. */
function schedule(delay: number) {
  window.clearTimeout(timer);
  timer = window.setTimeout(() => {
    const left = last + AWAKE_MS - performance.now();
    if (left > 50) schedule(left);
    else set(false);
  }, delay);
}

/** An input: awake now, and again for AWAKE_MS (pointer moves come many a second: the timer is not reset for each). */
function poke() {
  last = performance.now();
  if (!awake) {
    set(true);
    schedule(AWAKE_MS);
  }
}

function start() {
  if (started || typeof window === "undefined") return;
  started = true;
  document.documentElement.setAttribute("data-awake", "");
  const options = { passive: true, capture: true } as const;
  for (const type of [
    "pointermove",
    "pointerdown",
    "keydown",
    "wheel",
    "touchstart",
    "scroll",
  ])
    window.addEventListener(type, poke, options);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) poke();
  });
  last = performance.now();
  schedule(AWAKE_MS);
}

/** Whether the page is awake now (starts watching on first use). */
export function isAwake() {
  start();
  return awake;
}

/** Called when the page wakes or falls asleep; returns the unsubscribe. */
export function onAwakeChange(listener: () => void) {
  start();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Awake (true) or idle (false), as React state. */
export function useAwake() {
  return useSyncExternalStore(onAwakeChange, isAwake, () => true);
}
