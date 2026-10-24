import type {
  RankBoard,
  RankPage,
  RankRange,
  RankVisibility,
} from "@hb/contracts";
import {
  type InfiniteData,
  type QueryClient,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { api } from "../api";
import { readResponse } from "./activities";

// 排行榜 (docs/leaderboard-design.md): the boards 20 at a time, and one's
// own two switches.

const rankKey = (userId: string | null) => ["rank", userId] as const;
const visibilityKey = (userId: string | null) =>
  ["rank-visibility", userId] as const;

/** A board, 20 at a time; who reads it decides `me`. */
export function useRankPages(
  board: RankBoard,
  range: RankRange,
  userId: string | null,
) {
  return useInfiniteQuery({
    queryKey: [...rankKey(userId), board, range],
    initialPageParam: null as string | null,
    queryFn: async ({ pageParam, signal }) =>
      readResponse<RankPage>(
        await api.api.rank.$get(
          {
            query: {
              board,
              range,
              ...(pageParam ? { cursor: pageParam } : {}),
            },
          },
          { init: { signal, cache: "no-store" } },
        ),
      ),
    getNextPageParam: (last) => last.nextCursor,
    retry: false,
    refetchOnWindowFocus: false,
  });
}

export function useRankVisibility(userId: string | null) {
  return useQuery({
    queryKey: visibilityKey(userId),
    enabled: userId !== null,
    retry: false,
    queryFn: async ({ signal }) =>
      readResponse<RankVisibility>(
        await api.api.me["rank-visibility"].$get(undefined, {
          init: { signal, cache: "no-store" },
        }),
      ),
  });
}

/** Every loaded page of one board says `visible` for the one reading. */
function patchBoards(
  queryClient: QueryClient,
  userId: string,
  board: RankBoard,
  visible: boolean,
) {
  queryClient.setQueriesData<InfiniteData<RankPage>>(
    { queryKey: [...rankKey(userId), board] },
    (data) =>
      data && {
        ...data,
        pages: data.pages.map((page) =>
          page.me ? { ...page, me: { ...page.me, visible } } : page,
        ),
      },
  );
}

/**
 * 在发出榜 / 领到榜上显示我: flips at once wherever it shows (the boards,
 * /me), back again if it was not saved. Who others see is read anew.
 */
export function useSetRankVisibility(userId: string, csrfToken: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: { board: RankBoard; visible: boolean }) =>
      readResponse<RankVisibility>(
        await api.api.me["rank-visibility"].$patch(
          { json: input },
          { headers: { "X-CSRF-Token": csrfToken } },
        ),
      ),
    onMutate: ({ board, visible }) => {
      const before = queryClient.getQueryData<RankVisibility>(
        visibilityKey(userId),
      );
      if (before)
        queryClient.setQueryData(visibilityKey(userId), {
          ...before,
          [board]: visible,
        });
      patchBoards(queryClient, userId, board, visible);
      return { before };
    },
    onError: (_error, { board, visible }, context) => {
      if (context?.before)
        queryClient.setQueryData(visibilityKey(userId), context.before);
      patchBoards(queryClient, userId, board, !visible);
    },
    onSuccess: (visibility) => {
      queryClient.setQueryData(visibilityKey(userId), visibility);
      for (const board of ["sent", "received"] as const)
        patchBoards(queryClient, userId, board, visibility[board]);
    },
  });
}
