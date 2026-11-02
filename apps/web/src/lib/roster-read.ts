import type {
  AuthorClaim,
  AuthorRegistration,
  PublicRecipient,
  PublicRegistration,
} from "@hb/contracts";
import { readResponse } from "./activities";

// One page of a 红包's 名单 from 红包站. The forum's mini app builds its own
// in its place (apps/mini/vite.config.ts), reading through the forum.

export type RosterKind = "claims" | "registrations";

export type RosterItem =
  | PublicRecipient
  | PublicRegistration
  | AuthorClaim
  | AuthorRegistration;
export type RosterPage = { items: RosterItem[]; nextCursor: string | null };

const publicPath = { claims: "recipients", registrations: "registrations" };

export async function readRosterPage({
  activityId,
  kind,
  cursor,
  author,
  signal,
}: {
  activityId: string;
  kind: RosterKind;
  cursor: string | null;
  /** The sender's own view: from their endpoints, with 口令 and payments. */
  author: boolean;
  signal: AbortSignal;
}): Promise<RosterPage> {
  const query = cursor ? `?cursor=${encodeURIComponent(cursor)}` : "";
  const path = author
    ? `/api/me/activities/${encodeURIComponent(activityId)}/${kind}`
    : `/api/activities/${encodeURIComponent(activityId)}/${publicPath[kind]}`;
  return readResponse<RosterPage>(
    await fetch(`${path}${query}`, { signal, cache: "no-store" }),
  );
}
