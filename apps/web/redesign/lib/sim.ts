// The dev toolbar's 提交结果 fails a submission once; trying the same thing
// again goes through, so both sides of each failure can be seen. Keys name
// the submission (a claim's 红包 and 口令, a 红包's save…). Switching the
// toolbar starts over.

const failed = new Set<string>();

/** True the first time a submission is seen (it fails), false after. */
export function failsOnce(key: string) {
  if (failed.has(key)) return false;
  failed.add(key);
  return true;
}

/** Counts a submission as already failed (a draft that failed to open). */
export function markFailed(key: string) {
  failed.add(key);
}

export function resetFailures() {
  failed.clear();
}
