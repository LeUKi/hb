import type { Page } from "./types";

export const BEFORE_PROTOTYPE_NAVIGATION = "prototype-before-navigation";
export const PROTOTYPE_HISTORY_CHANGED = "prototype-history-changed";

export type HistoryOrigin = { hash: string; index: number };
export type PrototypeNavigationDetail = {
  page: Page;
  hash: string | null;
  origin?: HistoryOrigin;
};

const historyDecisions = new WeakMap<Event, boolean>();
const ignoredHistoryEvents = new WeakSet<Event>();
let restoringOrigin: HistoryOrigin | null = null;
let lastEntryIndex: number | null = null;

export function allowPrototypeNavigation(
  page: Page,
  event?: PopStateEvent | HashChangeEvent,
  origin?: HistoryOrigin,
) {
  if (event && historyDecisions.has(event))
    return historyDecisions.get(event) ?? false;
  const detail: PrototypeNavigationDetail = {
    page,
    hash: event ? window.location.hash : null,
    origin,
  };
  const allowed = window.dispatchEvent(
    new CustomEvent(BEFORE_PROTOTYPE_NAVIGATION, {
      cancelable: true,
      detail,
    }),
  );
  if (event) {
    historyDecisions.set(event, allowed);
    if (!allowed && detail.origin && !restoringOrigin) {
      const delta = detail.origin.index - historyEntryIndex();
      if (delta) {
        restoringOrigin = detail.origin;
        window.history.go(delta);
      }
    }
  }
  return allowed;
}

export function isPrototypeHistoryRestoring(event: Event) {
  if (ignoredHistoryEvents.has(event)) return true;
  if (!restoringOrigin) return false;
  ignoredHistoryEvents.add(event);
  if (
    window.location.hash === restoringOrigin.hash &&
    historyEntryIndex() === restoringOrigin.index
  )
    restoringOrigin = null;
  return true;
}

export function historyEntryIndex() {
  const navigation = (
    window as Window & {
      navigation?: { currentEntry?: { index: number } };
    }
  ).navigation;
  const nativeIndex = navigation?.currentEntry?.index;
  const savedIndex = window.history.state?.prototypeEntryIndex as
    | number
    | undefined;
  const validNative =
    nativeIndex !== undefined && Number.isSafeInteger(nativeIndex);
  const validSaved =
    savedIndex !== undefined && Number.isSafeInteger(savedIndex);
  const index = validNative
    ? nativeIndex
    : validSaved
      ? savedIndex
      : (lastEntryIndex ?? -1) + 1;
  if (!validSaved)
    window.history.replaceState(
      { ...window.history.state, prototypeEntryIndex: index },
      "",
    );
  lastEntryIndex = index;
  return index;
}

function notifyHistoryChange() {
  // pushState/replaceState do not emit native history events. Keep every
  // mounted navigation guard anchored to the entry actually on screen.
  window.dispatchEvent(
    new CustomEvent<HistoryOrigin>(PROTOTYPE_HISTORY_CHANGED, {
      detail: { hash: window.location.hash, index: historyEntryIndex() },
    }),
  );
}

export function pushPrototypeHistory(
  state: Record<string, unknown> | null,
  hash: string,
) {
  const index = historyEntryIndex() + 1;
  window.history.pushState({ ...state, prototypeEntryIndex: index }, "", hash);
  lastEntryIndex = index;
  notifyHistoryChange();
}

export function replacePrototypeHistory(
  state: Record<string, unknown> | null,
  hash?: string,
) {
  const index = historyEntryIndex();
  window.history.replaceState(
    { ...state, prototypeEntryIndex: index },
    "",
    hash,
  );
  notifyHistoryChange();
}
