import type { ActivityViewersDetail } from "@hb/contracts";
import { readResponse } from "./activities";

// 在看人数's card (docs/viewer-stats-design.md): the numbers and the curve,
// read each time it opens. While the 红包 runs they come from its object,
// once it is over from what the object wrote.

export const viewersKey = (id: string) => ["activity-viewers", id] as const;

export async function readViewers(id: string, signal?: AbortSignal) {
  return readResponse<ActivityViewersDetail>(
    // Plain fetch: the route is outside the typed chain (api app.ts).
    await fetch(`/api/activities/${encodeURIComponent(id)}/viewers`, {
      signal,
      cache: "no-store",
    }),
  );
}
