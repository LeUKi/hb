import { atom, type createStore } from "jotai";

// 领取范围 (docs/claim-scope-design.md §5): someone outside who presses the
// seal (or whose claim the server turned away) is told who may.

/** The 红包 whose 领取范围 is being shown, or none. */
export const scopeNoticeAtom = atom<{ activityId: string } | null>(null);

export function noteOutOfScope(
  store: ReturnType<typeof createStore>,
  activityId: string,
) {
  store.set(scopeNoticeAtom, { activityId });
}
