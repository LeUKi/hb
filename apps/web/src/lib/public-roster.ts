import type {
  AuthorClaimList,
  AuthorRegistrationList,
  ManagedActivity,
  PublicActivity,
  PublicRecipientList,
  PublicRegistrationList,
} from "@hb/contracts";
import {
  type RefetchOptions,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  activityKeys,
  nextPublicActivityReadGeneration,
  type PublicActivityDetail,
  readResponse,
  useMountedPageFocusRefresh,
} from "./activities";
import { type SessionResponse, sessionIdentity, sessionQueryKey } from "./auth";
import { isAccessQueryError } from "./query-view";

export type PublicRosterTab = "recipients" | "registrations";
export type PublicRosterView = "public" | "author";
type RosterPage =
  | PublicRecipientList
  | PublicRegistrationList
  | AuthorClaimList
  | AuthorRegistrationList;
export type PublicRosterSnapshot = {
  activity: PublicActivity;
  managedActivity?: ManagedActivity;
  readGeneration: number;
  pages: RosterPage[];
  pageParams: Array<string | null>;
};

function isPublicPage(
  page: RosterPage,
): page is PublicRecipientList | PublicRegistrationList {
  return "enabled" in page;
}

function pageEnabled(page: RosterPage) {
  return !isPublicPage(page) || page.enabled;
}

function pageNextCursor(page: RosterPage | undefined) {
  return page?.nextCursor ?? null;
}

function redactPages(
  pages: RosterPage[],
  activity: PublicActivity,
): RosterPage[] {
  if (!activity.showRecipientList)
    return [{ enabled: false, items: [], nextCursor: null }];
  return pages.map((page) => {
    if (!isPublicPage(page)) return page;
    const items = page.items.map((row) => {
      const safe = { ...row };
      if (!activity.showRecipientUsername) {
        safe.username = "";
        safe.displayName = "匿名用户";
        safe.avatarUrl = null;
        safe.accountTier = null;
      }
      if (!activity.showRecipientTime) {
        if ("claimedAt" in safe) delete safe.claimedAt;
        if ("registeredAt" in safe) delete safe.registeredAt;
      }
      if (activity.showRecipientAmount === false) {
        if ("amount" in safe) delete safe.amount;
        if ("title" in safe) delete safe.title;
      }
      return safe;
    });
    const safePage = { ...page, items };
    if (activity.showRecipientAmount === false && "titles" in safePage)
      delete safePage.titles;
    return safePage;
  });
}

/** Revocations take effect even if a later record page cannot be read. */
function restrictSnapshot(
  previous: PublicRosterSnapshot,
  fresh: PublicActivity,
): PublicRosterSnapshot | undefined {
  const old = previous.activity;
  const precision = { hidden: 0, availability: 1, fuzzy: 2, exact: 3 };
  const quantityHidden =
    precision[fresh.quantity.mode] < precision[old.quantity.mode];
  const listHidden = old.showRecipientList && !fresh.showRecipientList;
  const usernameHidden =
    old.showRecipientUsername && !fresh.showRecipientUsername;
  const timeHidden = old.showRecipientTime && !fresh.showRecipientTime;
  const amountHidden =
    old.showRecipientAmount !== false && fresh.showRecipientAmount === false;
  const drawHidden = Boolean(
    old.draw &&
      fresh.draw &&
      ((old.draw.registeredCount !== null &&
        fresh.draw.registeredCount === null) ||
        (old.draw.winnerCount !== null && fresh.draw.winnerCount === null) ||
        (old.draw.participantLimit !== undefined &&
          fresh.draw.participantLimit === undefined)),
  );
  if (
    !quantityHidden &&
    !listHidden &&
    !usernameHidden &&
    !timeHidden &&
    !amountHidden &&
    !drawHidden
  )
    return undefined;
  const activity: PublicActivity = {
    ...old,
    quantity: quantityHidden ? fresh.quantity : old.quantity,
    showRecipientList: old.showRecipientList && fresh.showRecipientList,
    showRecipientUsername:
      old.showRecipientUsername && fresh.showRecipientUsername,
    showRecipientTime: old.showRecipientTime && fresh.showRecipientTime,
    showRecipientAmount: amountHidden ? false : old.showRecipientAmount,
    ...(old.draw && fresh.draw
      ? {
          draw: {
            ...old.draw,
            registeredCount:
              fresh.draw.registeredCount === null
                ? null
                : old.draw.registeredCount,
            winnerCount:
              fresh.draw.winnerCount === null ? null : old.draw.winnerCount,
            participantLimit:
              fresh.draw.participantLimit === undefined
                ? undefined
                : old.draw.participantLimit,
          },
        }
      : {}),
  };
  return {
    ...previous,
    activity,
    pages: redactPages(previous.pages, activity),
    pageParams: listHidden ? [null] : previous.pageParams,
  };
}

export function usePublicRoster({
  activity: baseActivity,
  detailGeneration,
  activityId,
  userId,
  identity,
  view,
  tab,
  enabled,
  restoredPageCount,
}: {
  activity?: PublicActivity;
  detailGeneration: number;
  activityId: string;
  userId: string | null;
  identity: string | null;
  view: PublicRosterView;
  tab: PublicRosterTab;
  enabled: boolean;
  restoredPageCount: number;
}) {
  const client = useQueryClient();
  const queryKey = useMemo(
    () => ["activity-roster", activityId, identity, view, tab] as const,
    [activityId, identity, view, tab],
  );
  const scope = JSON.stringify(queryKey);
  const current = useRef({
    scope,
    enabled,
    pageCount: restoredPageCount,
    restoredPageCount,
    operation: "refresh" as "refresh" | "append",
  });
  if (current.current.scope !== scope)
    current.current = {
      scope,
      enabled,
      pageCount: restoredPageCount,
      restoredPageCount,
      operation: "refresh",
    };
  current.current.enabled = enabled;
  current.current.restoredPageCount = restoredPageCount;
  const [more, setMore] = useState({ scope, fetching: false, failed: false });
  const query = useQuery<PublicRosterSnapshot>({
    queryKey,
    // All refresh sources use the same refetch(false), including invalidation.
    // Native invalidation refetch would otherwise cancel a running round.
    enabled: false,
    retry: false,
    refetchOnWindowFocus: false,
    queryFn: async ({ signal }) => {
      const isCurrent = () =>
        !signal.aborted &&
        current.current.scope === scope &&
        current.current.enabled &&
        client.getQueryState(sessionQueryKey)?.status === "success" &&
        sessionIdentity(
          client.getQueryData<SessionResponse>(sessionQueryKey)?.user ?? null,
        ) === identity;
      const assertCurrent = () => {
        if (!isCurrent()) throw new DOMException("读取已过期", "AbortError");
      };
      const publishDetail = (
        activity: PublicActivity,
        readGeneration: number,
      ) => {
        const detailKey = activityKeys.public(activityId, userId);
        const cached = client.getQueryData<PublicActivityDetail>(detailKey);
        if (isCurrent() && (cached?.readGeneration ?? 0) <= readGeneration)
          client.setQueryData(detailKey, {
            activity,
            readGeneration,
          });
      };
      const publishManaged = (activity: ManagedActivity) => {
        if (!userId) return;
        const detailKey = activityKeys.detail(userId, activityId);
        const cached = client.getQueryData<{ activity: ManagedActivity }>(
          detailKey,
        );
        if (isCurrent() && (cached?.activity.version ?? 0) <= activity.version)
          client.setQueryData(detailKey, { activity });
      };
      const readPage = async (cursor: string | null) => {
        const params = cursor ? `?cursor=${encodeURIComponent(cursor)}` : "";
        const path =
          view === "author"
            ? `/api/me/activities/${encodeURIComponent(activityId)}/${tab === "registrations" ? "registrations" : "claims"}${params}`
            : `/api/activities/${encodeURIComponent(activityId)}/${tab}${params}`;
        return readResponse<RosterPage>(
          await fetch(path, { signal, cache: "no-store" }),
        );
      };
      try {
        const previous = client.getQueryData<PublicRosterSnapshot>(queryKey);
        if (current.current.operation === "append" && previous) {
          const cursor = pageNextCursor(previous.pages.at(-1));
          if (!cursor) return previous;
          const page = await readPage(cursor);
          assertCurrent();
          const nextCursor = pageNextCursor(page);
          if (nextCursor && previous.pageParams.includes(nextCursor))
            throw new Error("名单分页位置重复，请重试刷新。");
          const activity = pageEnabled(page)
            ? previous.activity
            : { ...previous.activity, showRecipientList: false };
          const snapshot = {
            activity,
            managedActivity: previous.managedActivity,
            readGeneration: previous.readGeneration ?? 0,
            pages:
              view === "author"
                ? [...previous.pages, page]
                : redactPages([...previous.pages, page], activity),
            pageParams: pageEnabled(page)
              ? [...previous.pageParams, cursor]
              : [null],
          };
          current.current.pageCount = snapshot.pages.length;
          return snapshot;
        }
        // Finish the handoff from any independent detail poll before reading it.
        await client.cancelQueries({
          queryKey: activityKeys.public(activityId, userId),
          exact: true,
        });
        assertCurrent();
        const managed =
          view === "author"
            ? await readResponse<{ activity: ManagedActivity }>(
                await fetch(
                  `/api/me/activities/${encodeURIComponent(activityId)}`,
                  { signal, cache: "no-store" },
                ),
              )
            : undefined;
        assertCurrent();
        const { activity: fresh } = await readResponse<{
          activity: PublicActivity;
        }>(
          await fetch(`/api/activities/${encodeURIComponent(activityId)}`, {
            signal,
            cache: "no-store",
          }),
        );
        assertCurrent();
        const readGeneration = nextPublicActivityReadGeneration(
          Math.max(
            previous?.readGeneration ?? 0,
            client.getQueryData<PublicActivityDetail>(
              activityKeys.public(activityId, userId),
            )?.readGeneration ?? 0,
          ),
        );
        const restricted =
          view === "public" && previous && restrictSnapshot(previous, fresh);
        if (restricted) {
          client.setQueryData(queryKey, restricted, {
            updatedAt: client.getQueryState(queryKey)?.dataUpdatedAt,
          });
          publishDetail(fresh, readGeneration);
        }
        const pageCount = Math.max(
          1,
          current.current.pageCount,
          previous?.pages.length ?? 0,
        );
        const pages: RosterPage[] = [];
        const pageParams: Array<string | null> = [];
        let cursor: string | null = null;
        let activity = fresh;
        if (view === "public" && !fresh.showRecipientList) {
          pages.push({ enabled: false, items: [], nextCursor: null });
          pageParams.push(null);
        } else {
          for (let index = 0; index < pageCount; index += 1) {
            const page = await readPage(cursor);
            assertCurrent();
            if (!pageEnabled(page)) {
              activity = { ...fresh, showRecipientList: false };
              pages.splice(0, pages.length, {
                enabled: false,
                items: [],
                nextCursor: null,
              });
              pageParams.splice(0, pageParams.length, null);
              break;
            }
            pages.push(page);
            pageParams.push(cursor);
            cursor = pageNextCursor(page);
            if (!cursor) break;
            if (pageParams.includes(cursor))
              throw new Error("名单分页位置重复，请重试刷新。");
          }
        }
        assertCurrent();
        const snapshot = {
          activity,
          managedActivity: managed?.activity ?? previous?.managedActivity,
          readGeneration,
          pages: view === "author" ? pages : redactPages(pages, activity),
          pageParams,
        };
        if (managed) publishManaged(managed.activity);
        current.current.pageCount = pages.length;
        return snapshot;
      } catch (error) {
        if (
          isCurrent() &&
          error instanceof Error &&
          isAccessQueryError(error)
        ) {
          const detail = client.getQueryCache().find({
            queryKey:
              view === "author" && userId
                ? activityKeys.detail(userId, activityId)
                : activityKeys.public(activityId, userId),
            exact: true,
          });
          void detail?.cancel({ revert: false, silent: true });
          detail?.setState({
            data: undefined,
            dataUpdatedAt: 0,
            status: "error",
            fetchStatus: "idle",
            error,
          });
        }
        throw error;
      }
    },
  });
  const data = useMemo(
    () =>
      query.data &&
      baseActivity &&
      view === "public" &&
      detailGeneration > (query.data.readGeneration ?? 0)
        ? (restrictSnapshot(query.data, baseActivity) ?? query.data)
        : query.data,
    [query.data, baseActivity, detailGeneration, view],
  );
  useLayoutEffect(() => {
    if (
      !enabled ||
      client.getQueryState(sessionQueryKey)?.status !== "success" ||
      sessionIdentity(
        client.getQueryData<SessionResponse>(sessionQueryKey)?.user ?? null,
      ) !== identity
    )
      return;
    if (data && data !== query.data)
      client.setQueryData(queryKey, data, { updatedAt: query.dataUpdatedAt });
    // Normal results reach the page and dialog before the detail cache changes.
    const detailKey = activityKeys.public(activityId, userId);
    const currentDetail = client.getQueryData<PublicActivityDetail>(detailKey);
    if (
      data &&
      !query.isFetching &&
      !query.isError &&
      data.readGeneration >= (currentDetail?.readGeneration ?? 0)
    )
      client.setQueryData(detailKey, {
        activity: data.activity,
        readGeneration: data.readGeneration,
      });
    if (query.isError)
      client.getQueryCache().find({ queryKey, exact: true })?.setState({
        isInvalidated: false,
      });
  }, [
    client,
    enabled,
    identity,
    activityId,
    userId,
    queryKey,
    data,
    query.data,
    query.dataUpdatedAt,
    query.isFetching,
    query.isError,
  ]);
  const refetch = useCallback(
    (options?: RefetchOptions) => {
      if (client.getQueryState(queryKey)?.fetchStatus !== "fetching") {
        const cached = client.getQueryData<PublicRosterSnapshot>(queryKey);
        current.current.pageCount = Math.max(
          1,
          current.current.restoredPageCount,
          cached?.pages.length ?? 0,
        );
        current.current.operation = "refresh";
        setMore({ scope, fetching: false, failed: false });
      }
      return query.refetch({ ...options, cancelRefetch: false });
    },
    [client, queryKey, scope, query.refetch],
  );
  const fetchNextPage = useCallback(async () => {
    if (client.getQueryState(queryKey)?.fetchStatus === "fetching")
      return query.refetch({ cancelRefetch: false });
    const cached = client.getQueryData<PublicRosterSnapshot>(queryKey);
    const cachedPageCount = cached?.pages.length ?? 0;
    if (!cached || !pageNextCursor(cached.pages.at(-1))) return;
    current.current.operation = "append";
    setMore({ scope, fetching: true, failed: false });
    const result = await query.refetch({ cancelRefetch: false });
    if (current.current.scope === scope) {
      current.current.pageCount = result.data?.pages.length ?? cachedPageCount;
      current.current.operation = "refresh";
      setMore({ scope, fetching: false, failed: result.isError });
    }
    return result;
  }, [client, queryKey, scope, query.refetch]);
  const refreshOnFocus = useCallback(
    () => (enabled ? refetch() : undefined),
    [enabled, refetch],
  );
  useMountedPageFocusRefresh(refreshOnFocus);
  useEffect(() => {
    if (!enabled) return;
    const cached = client.getQueryData<PublicRosterSnapshot>(queryKey);
    const state = client.getQueryState(queryKey);
    const age = Date.now() - (state?.dataUpdatedAt ?? 0);
    const reuse =
      cached &&
      state?.status === "success" &&
      !state.isInvalidated &&
      age < 5_000 &&
      cached.pages.length >= current.current.restoredPageCount;
    if (!reuse) void refetch();
    let timer: number;
    const poll = () => {
      if (document.visibilityState !== "hidden") void refetch();
      timer = window.setTimeout(poll, 5_000);
    };
    timer = window.setTimeout(poll, reuse ? Math.max(0, 5_000 - age) : 5_000);
    let stopped = false;
    let invalidationScheduled = false;
    let pendingInvalidation = false;
    let draining = false;
    const drainInvalidations = async () => {
      if (draining) return;
      draining = true;
      try {
        while (pendingInvalidation && !stopped) {
          pendingInvalidation = false;
          // A mutation committed after an old GET began needs a later read.
          if (client.getQueryState(queryKey)?.fetchStatus === "fetching")
            await query.refetch({ cancelRefetch: false });
          if (stopped) break;
          await refetch();
        }
      } finally {
        draining = false;
      }
    };
    const unsubscribe = client.getQueryCache().subscribe((event) => {
      if (event.type !== "updated" || event.action.type !== "invalidate")
        return;
      const key = event.query.queryKey;
      const publicDetail =
        key[0] === "activity-public" &&
        key[1] === activityId &&
        key[2] === userId;
      const privateDetail =
        key[0] === "activity-private" &&
        key[1] === userId &&
        key[2] === "detail" &&
        key[3] === activityId;
      const thisRoster =
        key[0] === "activity-roster" &&
        key[1] === activityId &&
        key[2] === identity &&
        key[3] === view &&
        key[4] === tab;
      if (!publicDetail && !privateDetail && !thisRoster) return;
      // Acknowledge the event so another invalidation can retry a failed round.
      // setState/fetch events are deliberately ignored by this listener.
      event.query.setState({ isInvalidated: false });
      if (invalidationScheduled) return;
      invalidationScheduled = true;
      // One mutation commonly invalidates both public and roster prefixes.
      queueMicrotask(() => {
        invalidationScheduled = false;
        if (stopped) return;
        pendingInvalidation = true;
        void drainInvalidations();
      });
    });
    return () => {
      stopped = true;
      window.clearTimeout(timer);
      unsubscribe();
      void client.cancelQueries({ queryKey, exact: true });
    };
  }, [
    client,
    activityId,
    userId,
    identity,
    view,
    tab,
    enabled,
    queryKey,
    query.refetch,
    refetch,
  ]);
  return {
    ...query,
    data,
    refetch,
    fetchNextPage,
    hasNextPage: Boolean(pageNextCursor(data?.pages.at(-1))),
    view,
    scope,
    isFetchingNextPage:
      more.scope === scope && more.fetching && query.isFetching,
    isFetchNextPageError: more.scope === scope && more.failed,
  };
}

export type PublicRosterQuery = ReturnType<typeof usePublicRoster>;
