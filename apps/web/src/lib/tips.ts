// 打赏 on 红包站 (docs/tip-design.md §7): 我的打赏 (cards and the table) for
// their owner, and a card as anyone sees it, with what it does.

import type {
  CreateTipInput,
  TipCard,
  TipCardInput,
  TipCardView,
  TipList,
  TipMethod,
  TipMethods,
  TipPaletteOption,
  TipRange,
  TipReceipt,
  TipResult,
  UpdateTipCardInput,
} from "@hb/contracts";
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useMemo } from "react";
import { api } from "../api";
import type { PlusInfo } from "../components/balance/plus";
import { tipForumEmbed } from "../components/tips/embed";
import type { TipCardActions } from "../components/tips/tip-card";

export { previewOf } from "../components/tips/tip-card";

import { readResponse } from "./activities";
import { solveCap } from "./cap";
import { useIdentity } from "./session";

export type MyTips = {
  cards: TipCard[];
  used: number;
  limit: number;
  enabled: boolean;
  plus: PlusInfo;
  /** The palettes to choose, the default first (served: tip-design §12). */
  palettes: TipPaletteOption[];
  /** Whether tips can come in at Credit 站 (one's own LDC 商户), and why not. */
  receiving: TipMethods["checkout"];
};

export const tipKeys = {
  mine: (userId: string) => ["tips", userId, "mine"] as const,
  list: (
    userId: string,
    side: "in" | "out",
    filter: { card?: string; method?: TipMethod; range: TipRange },
  ) => ["tips", userId, "list", side, filter] as const,
  card: (code: string, userId: string | null) =>
    ["tip-card", code, userId ?? "guest"] as const,
  receipt: (code: string, id: string) => ["tip-receipt", code, id] as const,
};

function useCsrf() {
  const { csrfToken } = useIdentity();
  return { headers: { "X-CSRF-Token": csrfToken ?? "" } };
}

export function useMyTips(userId: string) {
  return useQuery({
    queryKey: tipKeys.mine(userId),
    queryFn: async ({ signal }) =>
      readResponse<MyTips>(
        await api.api.me.tips.$get(undefined, {
          init: { signal, cache: "no-store" },
        }),
      ),
    retry: false,
  });
}

/** 新建、保存、停用、启用: each answers with the card, and 我的打赏 reads again. */
export function useTipCardActions(userId: string) {
  const queryClient = useQueryClient();
  const options = useCsrf();
  const done = async () => {
    await queryClient.invalidateQueries({ queryKey: ["tips", userId] });
  };
  type One = { card: TipCard };
  return {
    create: useMutation({
      mutationFn: async (input: TipCardInput) =>
        readResponse<One>(
          await api.api.me.tips.cards.$post({ json: input }, options),
        ),
      onSuccess: done,
    }),
    update: useMutation({
      mutationFn: async ({
        code,
        input,
      }: {
        code: string;
        input: UpdateTipCardInput;
      }) =>
        readResponse<One>(
          await api.api.me.tips.cards[":code"].$patch(
            { param: { code }, json: input },
            options,
          ),
        ),
      onSuccess: done,
    }),
    stop: useMutation({
      mutationFn: async (code: string) =>
        readResponse<One>(
          await api.api.me.tips.cards[":code"].stop.$post(
            { param: { code } },
            options,
          ),
        ),
      onSuccess: done,
    }),
    start: useMutation({
      mutationFn: async (code: string) =>
        readResponse<One>(
          await api.api.me.tips.cards[":code"].start.$post(
            { param: { code } },
            options,
          ),
        ),
      onSuccess: done,
    }),
    hideMessage: useMutation({
      mutationFn: async ({ id, hidden }: { id: string; hidden: boolean }) =>
        readResponse(
          await api.api.me.tips[":id"].message.$post(
            { param: { id }, json: { hidden } },
            options,
          ),
        ),
      onSuccess: done,
    }),
  };
}

/** 收到的 / 我打赏的, a page at a time. */
export function useTipList(
  userId: string,
  side: "in" | "out",
  filter: { card?: string; method?: TipMethod; range: TipRange },
) {
  return useInfiniteQuery({
    queryKey: tipKeys.list(userId, side, filter),
    initialPageParam: undefined as string | undefined,
    queryFn: async ({ pageParam, signal }) => {
      const url = api.api.me.tips.list[":side"].$url({ param: { side } });
      url.searchParams.set("range", filter.range);
      if (filter.card) url.searchParams.set("card", filter.card);
      if (filter.method) url.searchParams.set("method", filter.method);
      if (pageParam) url.searchParams.set("cursor", pageParam);
      return readResponse<TipList>(
        await fetch(url, {
          signal,
          cache: "no-store",
          credentials: "same-origin",
        }),
      );
    },
    getNextPageParam: (last) => last.cursor ?? undefined,
    retry: false,
    placeholderData: (previous) => previous,
  });
}

/** A card as this viewer sees it (☕ page, embeds, previews of one's own). */
export function useTipCard(code: string) {
  const { user } = useIdentity();
  return useQuery({
    queryKey: tipKeys.card(code, user?.id ?? null),
    queryFn: async ({ signal }) =>
      readResponse<TipCardView>(
        await api.api.tip[":code"].$get(
          { param: { code } },
          { init: { signal, cache: "no-store" } },
        ),
      ),
    retry: false,
  });
}

/**
 * What a card does on 红包站: a tip (signed in, with the CSRF token; a guest
 * with a Cap token), “查一下”, and the cashier opened in a new tab.
 */
export function useTipActions(
  code: string,
  capEndpoint: string | null,
  via: "web" | "embed" = "web",
): TipCardActions {
  const options = useCsrf();
  return useMemo(
    () => ({
      deliver: "open" as const,
      create: async (input: CreateTipInput) => {
        const url = api.api.tip[":code"].$url({ param: { code } });
        if (via === "embed") url.searchParams.set("via", via);
        return readResponse<TipResult>(
          await fetch(url, {
            method: "POST",
            credentials: "same-origin",
            headers: { "Content-Type": "application/json", ...options.headers },
            body: JSON.stringify(input),
          }),
        );
      },
      check: async (tipId: string) =>
        readResponse<TipResult>(
          await api.api.tip[":code"].tips[":id"].check.$post({
            param: { code, id: tipId },
          }),
        ),
      ...(capEndpoint
        ? {
            capToken: async () =>
              solveCap(capEndpoint, () => {}, new AbortController().signal),
          }
        : {}),
    }),
    [code, capEndpoint, via, options],
  );
}

export function useTipReceipt(code: string, id: string) {
  return useQuery({
    queryKey: tipKeys.receipt(code, id),
    queryFn: async ({ signal }) => {
      // Reading it asks Credit 站 once (at most every 5 s for anyone).
      await api.api.tip[":code"].tips[":id"].check
        .$post({ param: { code, id } })
        .catch(() => null);
      return readResponse<{ receipt: TipReceipt }>(
        await api.api.tip[":code"].tips[":id"].$get(
          { param: { code, id } },
          { init: { signal, cache: "no-store" } },
        ),
      );
    },
    retry: false,
    refetchInterval: (query) =>
      query.state.data?.receipt.status === "pending" ? 5000 : false,
  });
}

/** Where a card is put: the 社区 (in a post or 关于我) or a page outside it. */
export function tipEmbedCode(
  code: string,
  ownerName: string,
  cardHeight: number,
  place: "forum" | "outside",
) {
  if (place === "forum") return tipForumEmbed(code, ownerName, cardHeight);
  return `<iframe src="${window.location.origin}/☕/${code}?embed&theme=auto" title="打赏 ${ownerName}" width="100%" height="${cardHeight + 16}" frameborder="0"></iframe>`;
}

export const tipCardLink = (code: string) =>
  `${window.location.origin}/☕/${code}`;
