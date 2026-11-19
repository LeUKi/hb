import type { ActivityViewersDetail } from "@hb/contracts";
import { api } from "../api";
import { readResponse } from "./activities";

// 在看人数's card (docs/viewer-stats-design.md): the numbers and the curve,
// read each time it opens. While the 红包 runs they come from its object,
// once it is over from what the object wrote.

export const viewersKey = (id: string) => ["activity-viewers", id] as const;

export async function readViewers(id: string, signal?: AbortSignal) {
  return readResponse<ActivityViewersDetail>(
    await api.api.activities[":id"].viewers.$get(
      { param: { id } },
      { init: { signal, cache: "no-store" } },
    ),
  );
}
