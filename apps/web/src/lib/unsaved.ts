import { useEffect } from "react";

// Pages with unsaved edits (the ones a LeaveGuard asks about), so that
// something about to interrupt can wait: the update prompt (02-shell §8).
const marks = new Set<object>();

export function hasUnsavedEdits() {
  return marks.size > 0;
}

/** While `on`, this page has unsaved edits. */
export function useUnsavedMark(on: boolean) {
  useEffect(() => {
    if (!on) return;
    const mark = {};
    marks.add(mark);
    return () => {
      marks.delete(mark);
    };
  }, [on]);
}
