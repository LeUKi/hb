import type { MiniPointsCopy } from "@hb/contracts";
import { createContext, useContext } from "react";

// Built in place of apps/web/src/lib/points.ts (vite.config.ts): its reads
// are 红包站's own (/api/points/:id), which the 社区's frame cannot reach.
// The issuer's words a 红包's result card shows come with the mini app's
// read of that 红包 instead (MiniHongbaoResponse.pointsCopy), handed down
// through PointsCopyContext.

export const PointsCopyContext = createContext<MiniPointsCopy | null>(null);

/** lib/points.ts's usePointsDetail as far as the 红包 page reads it. */
export function usePointsDetail(_id: string) {
  const copy = useContext(PointsCopyContext);
  return {
    isPending: false,
    data: copy
      ? {
          system: {
            ...copy,
            // Sender-only words (author-tools.tsx): the sender's own view
            // is on 红包站.
            insufficient: "",
            keyInvalid: "",
          },
        }
      : undefined,
  };
}
