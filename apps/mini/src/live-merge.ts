import type { MiniLiveActivity, PublicActivity } from "@hb/contracts";

// A 红包 pushed on the live channel over the read it replaces (docs/mini-
// app-design.md §7). The push is the whole public read but for what
// liveMiniMessage (api activities/live.ts) leaves out, which is kept from
// the read; any other key it lacks is gone. Spreading the push over the
// old read kept those: a 商户余额不足 pause that had ended stayed on the
// seal until the app was hidden and shown again (sweep 2026-11-21, F4).

/** The read, as the push says it is now. */
export function withPushed(
  read: PublicActivity,
  pushed: MiniLiveActivity,
): PublicActivity {
  const {
    beforeInfo,
    afterEndInfo,
    rosterPreview,
    judge,
    page,
    drawProof,
    author,
    scope,
  } = read;
  return {
    ...pushed,
    beforeInfo,
    // Its people as the read had them: their pictures the 社区's
    // (forumAvatar), which the live channel does not say.
    author,
    ...(scope !== undefined ? { scope } : {}),
    ...(afterEndInfo !== undefined ? { afterEndInfo } : {}),
    ...(rosterPreview !== undefined ? { rosterPreview } : {}),
    ...(judge !== undefined ? { judge } : {}),
    ...(page !== undefined ? { page } : {}),
    ...(drawProof !== undefined ? { drawProof } : {}),
  };
}
