import type { ParticipationMode } from "@hb/contracts";

/** Missing fields belong to the original password participation protocol. */
export function isDirectParticipation(
  activity?: { participationMode?: ParticipationMode } | null,
) {
  return activity?.participationMode === "direct";
}

/** Recovery keeps existing direct activities usable and limits only new adoption. */
export const directParticipationCreationEnabled =
  import.meta.env.VITE_DIRECT_PARTICIPATION_RECOVERY !== "1";
