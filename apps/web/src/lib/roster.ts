import type {
  AuthorClaim,
  AuthorRegistration,
  PublicRecipient,
  PublicRegistration,
} from "@hb/contracts";
import { useInfiniteQuery } from "@tanstack/react-query";
import { readResponse } from "./activities";
import type { RosterRow } from "./hongbao";
import { paymentOpen } from "./live-state";
import type { RosterTitle } from "./titles";

// The 名单: always public (06 §2), oldest first (06 §3), 20 at a time. The
// sender reads the same lists from their own endpoints, which add the 口令
// each person used and the payment of each claim.

export type RosterKind = "claims" | "registrations";

type Item =
  | PublicRecipient
  | PublicRegistration
  | AuthorClaim
  | AuthorRegistration;
type Page = { items: Item[]; nextCursor: string | null };

const publicPath = { claims: "recipients", registrations: "registrations" };

/** One person's row, in list order (rank is the place in the list). */
function rowOf(item: Item, rank: number, viewer: string | null): RosterRow {
  if ("claimant" in item)
    return {
      id: item.id,
      rank,
      name: item.claimant.displayName || item.claimant.username,
      username: item.claimant.username,
      avatarUrl: item.claimant.avatarUrl,
      you: viewer !== null && item.claimant.username === viewer,
      amount: item.amount,
      at: Date.parse(item.claimedAt),
      // In the public list's order: 手气王 / 手气亡, then 手速王.
      titles: [
        ...(item.title ? [item.title] : []),
        ...(item.speedTitle ? [item.speedTitle] : []),
      ],
      password: item.sourcePassword ?? null,
      payment: item.payment,
    };
  if ("participant" in item)
    return {
      id: item.id,
      rank,
      name: item.participant.displayName || item.participant.username,
      username: item.participant.username,
      avatarUrl: item.participant.avatarUrl,
      you: viewer !== null && item.participant.username === viewer,
      amount: null,
      at: Date.parse(item.registeredAt),
      titles: [],
      password: item.sourcePassword ?? null,
    };
  const titles: RosterTitle[] = [];
  if ("title" in item && item.title) titles.push(item.title);
  if ("speedTitle" in item && item.speedTitle) titles.push(item.speedTitle);
  return {
    id: item.id,
    rank,
    name: item.displayName || item.username,
    username: item.username,
    avatarUrl: item.avatarUrl,
    you: viewer !== null && item.username === viewer,
    amount: "amount" in item ? (item.amount ?? null) : null,
    at: Date.parse("claimedAt" in item ? item.claimedAt : item.registeredAt),
    titles,
  };
}

/** One list of the roster: what has been read so far, and more to read. */
export function useRosterList(
  activityId: string,
  kind: RosterKind,
  options: {
    enabled: boolean;
    /** The viewer's username: their own row is marked "you". */
    viewer: string | null;
    /** The sender's own view (their user id). */
    author?: string | null;
    /**
     * How often to read it again, given whether a payment it shows is on
     * its way; false: not at all. Pushed changes read it again at once
     * (use-hongbao-data.ts).
     */
    poll: (paymentsOpen: boolean) => number | false;
  },
) {
  const author = options.author ?? null;
  const query = useInfiniteQuery({
    queryKey: author
      ? ["activity-roster", activityId, author, "author", kind]
      : ["activity-roster", activityId, "public", "public", kind],
    initialPageParam: null as string | null,
    queryFn: async ({ pageParam, signal }): Promise<Page> => {
      const cursor = pageParam
        ? `?cursor=${encodeURIComponent(pageParam)}`
        : "";
      const path = author
        ? `/api/me/activities/${encodeURIComponent(activityId)}/${kind}`
        : `/api/activities/${encodeURIComponent(activityId)}/${publicPath[kind]}`;
      return readResponse<Page>(
        await fetch(`${path}${cursor}`, { signal, cache: "no-store" }),
      );
    },
    getNextPageParam: (last) => last.nextCursor,
    enabled: options.enabled,
    retry: false,
    refetchInterval: (query) =>
      options.poll(
        Boolean(
          query.state.data?.pages.some((page) =>
            page.items.some(
              (item) => "payment" in item && paymentOpen(item.payment),
            ),
          ),
        ),
      ),
  });
  const rows = (query.data?.pages ?? [])
    .flatMap((page) => page.items)
    .map((item, index) => rowOf(item, index + 1, options.viewer));
  return { query, rows };
}
