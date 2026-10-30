import type {
  RoadmapAdminAction,
  RoadmapCreateInput,
  RoadmapDetail,
  RoadmapItem,
  RoadmapList,
  RoadmapRequestInput,
  RoadmapStatus,
  RoadmapSummary,
} from "@hb/contracts";
import {
  keepPreviousData,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { readResponse } from "./activities";
import { haptic } from "./haptics";
import { useIdentity } from "./session";

// 施工中 (docs/roadmap-design.md): the page's reads and writes, and
// 网站管理 · 施工's. Plain fetches; every read keyed by who reads, since
// each item says whether the reader voted.

export type RoadmapSort = "hot" | "new";

export const roadmapKey = ["roadmap"] as const;

const read = async <T>(path: string, signal?: AbortSignal) =>
  readResponse<T>(await fetch(path, { signal, cache: "no-store" }));

export function useRoadmapSummary() {
  const { user } = useIdentity();
  return useQuery({
    queryKey: [...roadmapKey, user?.id ?? null, "summary"],
    queryFn: ({ signal }) => read<RoadmapSummary>("/api/roadmap", signal),
    retry: false,
  });
}

/** 功能请求 (最热 / 最新), 已完成, 不做的: twenty at a time. */
export function useRoadmapList(
  status: Exclude<RoadmapStatus, "building">,
  sort: RoadmapSort,
  enabled = true,
) {
  const { user } = useIdentity();
  return useInfiniteQuery({
    queryKey: [...roadmapKey, user?.id ?? null, "list", status, sort],
    enabled,
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) =>
      read<RoadmapList>(
        `/api/roadmap/items?status=${status}&sort=${sort}${pageParam ? `&cursor=${encodeURIComponent(pageParam)}` : ""}`,
        signal,
      ),
    getNextPageParam: (last) => last.nextCursor,
    placeholderData: keepPreviousData,
    retry: false,
  });
}

export function useRoadmapDetail(id: string | null) {
  const { user } = useIdentity();
  return useQuery({
    queryKey: [...roadmapKey, user?.id ?? null, "detail", id],
    enabled: id !== null,
    queryFn: ({ signal }) =>
      read<RoadmapDetail>(
        `/api/roadmap/items/${encodeURIComponent(id ?? "")}`,
        signal,
      ),
    retry: false,
  });
}

/** 可能已经有人提了 (§3): the three most like what is typed. */
export function useRoadmapSimilar(q: string) {
  const { user } = useIdentity();
  const text = q.trim();
  return useQuery({
    queryKey: [...roadmapKey, user?.id ?? null, "similar", text],
    enabled: Array.from(text).length >= 2,
    queryFn: ({ signal }) =>
      read<RoadmapList>(
        `/api/roadmap/similar?q=${encodeURIComponent(text)}`,
        signal,
      ),
    placeholderData: keepPreviousData,
    retry: false,
    staleTime: 30_000,
  });
}

function useWrite() {
  const { csrfToken } = useIdentity();
  return async <T>(method: string, path: string, body?: unknown) =>
    readResponse<T>(
      await fetch(path, {
        method,
        headers: {
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
          "X-CSRF-Token": csrfToken ?? "",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        cache: "no-store",
      }),
    );
}

/** After a write: every list and count read again. */
function useRefresh() {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: roadmapKey });
}

/**
 * 点赞 (§2.4): turned at once on every list that has it, put back if the
 * save fails; the count as the server has it after.
 */
export function useRoadmapVote() {
  const write = useWrite();
  const queryClient = useQueryClient();
  const set = (id: string, voted: boolean, votes?: number) =>
    queryClient.setQueriesData({ queryKey: roadmapKey }, (data: unknown) =>
      patchItems(data, id, (item) => ({
        ...item,
        voted,
        votes: votes ?? Math.max(0, item.votes + (voted ? 1 : -1)),
      })),
    );
  return useMutation({
    mutationFn: ({ id, voted }: { id: string; voted: boolean }) =>
      write<{ votes: number; voted: boolean }>(
        "PUT",
        `/api/roadmap/items/${encodeURIComponent(id)}/vote`,
        { voted },
      ),
    onMutate: ({ id, voted }) => {
      haptic("light");
      set(id, voted);
    },
    onSuccess: (answer, { id }) => set(id, answer.voted, answer.votes),
    onError: (_error, { id, voted }) => set(id, !voted),
  });
}

/** Each item in a cached read, wherever it sits, changed by `change`. */
function patchItems(
  data: unknown,
  id: string,
  change: (item: RoadmapItem) => RoadmapItem,
): unknown {
  if (!data || typeof data !== "object") return data;
  const patch = (item: RoadmapItem) => (item.id === id ? change(item) : item);
  const value = data as Record<string, unknown>;
  if (Array.isArray(value.pages))
    return {
      ...value,
      pages: (value.pages as RoadmapList[]).map((page) => ({
        ...page,
        items: page.items.map(patch),
      })),
    };
  if (Array.isArray(value.building))
    return { ...value, building: (value.building as RoadmapItem[]).map(patch) };
  if (value.item && typeof value.item === "object")
    return { ...value, item: patch(value.item as RoadmapItem) };
  if (Array.isArray(value.items))
    return { ...value, items: (value.items as RoadmapItem[]).map(patch) };
  return data;
}

export function useRoadmapRequest() {
  const write = useWrite();
  const refresh = useRefresh();
  return useMutation({
    mutationFn: (input: RoadmapRequestInput & { id?: string }) => {
      const { id, ...body } = input;
      return write<{ item: RoadmapItem }>(
        id ? "PUT" : "POST",
        id
          ? `/api/roadmap/items/${encodeURIComponent(id)}`
          : "/api/roadmap/items",
        body,
      );
    },
    onSuccess: () => refresh(),
  });
}

export function useRoadmapDelete() {
  const write = useWrite();
  const refresh = useRefresh();
  return useMutation({
    mutationFn: (id: string) =>
      write("DELETE", `/api/roadmap/items/${encodeURIComponent(id)}`),
    onSuccess: () => refresh(),
  });
}

/** 网站管理 · 施工 (§4): every status, hidden ones too, with counts. */
export function useAdminRoadmap(status: RoadmapStatus) {
  const { user } = useIdentity();
  return useInfiniteQuery({
    queryKey: [...roadmapKey, user?.id ?? null, "admin", status],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) =>
      read<
        RoadmapList & {
          counts: Record<RoadmapStatus, number>;
        }
      >(
        `/api/admin/roadmap?status=${status}&sort=new${pageParam ? `&cursor=${encodeURIComponent(pageParam)}` : ""}`,
        signal,
      ),
    getNextPageParam: (last) => last.nextCursor,
    placeholderData: keepPreviousData,
    retry: false,
  });
}

export function useAdminRoadmapAct() {
  const write = useWrite();
  const refresh = useRefresh();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, action }: { id: string; action: RoadmapAdminAction }) =>
      write<{ item: RoadmapItem }>(
        "POST",
        `/api/admin/roadmap/items/${encodeURIComponent(id)}`,
        action,
      ),
    onSuccess: async () => {
      await refresh();
      void queryClient.invalidateQueries({ queryKey: ["admin-private"] });
    },
  });
}

export function useAdminRoadmapCreate() {
  const write = useWrite();
  const refresh = useRefresh();
  return useMutation({
    mutationFn: (input: RoadmapCreateInput) =>
      write<{ item: RoadmapItem }>("POST", "/api/admin/roadmap/items", input),
    onSuccess: () => refresh(),
  });
}
