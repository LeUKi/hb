// Built in place of apps/web/src/lib/viewers.ts (vite.config.ts): the 在看
// card reads 红包站 itself, and the mini app shows only the count from its
// live line (LiveViewers plain, user 2026-11-19). Nothing here reaches the
// network.
export function viewersKey(): never {
  throw new Error("在看人数的详情要到红包站看。");
}

export function readViewers(): never {
  throw new Error("在看人数的详情要到红包站看。");
}
