import type {
  ActivityAuthor,
  ActivityHistoryFilters,
  ActivityList,
  ActivityStatusCounts,
  ActivitySummary,
  DiscoveryCard,
  DiscoveryList,
  Participation,
  ParticipationList,
  PaymentState,
  PublicActivity,
} from "@hb/contracts";
import { useInfiniteQuery } from "@tanstack/react-query";
import { api } from "../api";
import {
  activityKeys,
  historyListRefreshOptions,
  readResponse,
} from "./activities";
import { claimKeys } from "./claims";
import {
  type HongbaoActivity,
  hongbaoOf,
  type PublicView,
  publicViewOf,
} from "./hongbao";
import { type ChipTone, mineOf } from "./hongbao-text";

// The lists of 红包 outside a 红包 page — the 红包广场 and the account's own
// 红包记录 — as the pages draw them: production's list rows mapped onto the
// 红包 page's shapes (lib/hongbao.ts), read 20 at a time.

/** A card on the 红包广场, with the viewer's own part in it. */
export type SquareRecord = {
  activity: HongbaoActivity;
  view: PublicView;
  mine: { text: string; tone: ChipTone } | null;
};

export function squareRecordOf(
  card: DiscoveryCard,
  viewerId: string | null,
): SquareRecord {
  const activity: PublicActivity = { ...card, beforeInfo: "" };
  return {
    activity: hongbaoOf(activity),
    view: publicViewOf(activity),
    mine:
      viewerId && card.author.id === viewerId
        ? { text: "你发的", tone: "gold" }
        : mineOf(card),
  };
}

/** A 红包 this account sent (drafts included), as its own lists show it. */
export type SentRecord = {
  activity: HongbaoActivity;
  view: PublicView;
  archived: boolean;
  scheduleFailure?: { at: string; reason: string };
};

export function sentRecordOf(
  summary: ActivitySummary,
  author: ActivityAuthor,
): SentRecord {
  // The sender always sees exact counts.
  const activity: PublicActivity = {
    participationMode: summary.participationMode,
    id: summary.id,
    title: summary.title,
    rewardType: "ldc",
    status: summary.status,
    author,
    forceDedicated: summary.forceDedicated,
    topicUrl: summary.topicUrl,
    openedAt: summary.openedAt,
    deadlineAt: summary.deadlineAt,
    quantity: {
      mode: "exact",
      total: summary.totalCount,
      claimed: summary.claimedCount,
      remaining: Math.max(0, summary.totalCount - summary.claimedCount),
    },
    reward: summary.reward,
    beforeInfo: "",
    ...(summary.paymentMode ? { paymentMode: summary.paymentMode } : {}),
    ...(summary.draw ? { draw: summary.draw } : {}),
    ...(summary.stopped ? { stopped: true as const } : {}),
    ...(summary.scheduledOpenAt
      ? { scheduledOpenAt: summary.scheduledOpenAt }
      : {}),
  };
  return {
    activity: hongbaoOf(activity),
    view: publicViewOf(activity),
    archived: summary.status === "archived",
    // 定时开放 that did not open (scheduled-opening §5): said on its row.
    ...(summary.scheduleFailure
      ? { scheduleFailure: summary.scheduleFailure }
      : {}),
  };
}

/** A claim or sign-up of this account, as 我参与的 lists it. */
export type JoinedRecord = {
  key: string;
  activityId: string;
  title: string;
  author: string;
  verb: "领取" | "报名";
  password: string | null;
  at: number;
  /** The amount taken, or how a sign-up went. */
  outcome: { label: string; tone: ChipTone; amount?: string };
  /** The payment of a claimed or won share; null for a sign-up. */
  payment: PaymentState | null;
  /** A 🐟额红包's: what was taken is in 🐟额 (在🐟额), no payment. */
  fish: boolean;
  /** 自领: the sender's own share, unpaid (docs/self-claim-design.md). */
  self: boolean;
  /** 代码判定红包: its code judged the claim (代码判定领取). */
  code: boolean;
  ended: boolean;
};

export function joinedRecordOf(item: Participation): JoinedRecord {
  const record = item.kind === "claim" ? item.claim : item.registration;
  const activity = record.activity;
  const base = {
    key: `${item.kind}:${record.id}`,
    activityId: activity.id,
    title: activity.title,
    author:
      activity.author?.displayName || activity.author?.username || "红包作者",
    password: record.sourcePassword ?? null,
    fish: activity.funding === "balance",
    code: activity.participationMode === "code",
    ended: activity.status !== "active",
  };
  if (item.kind === "claim")
    return {
      ...base,
      verb: "领取",
      at: Date.parse(item.claim.claimedAt),
      outcome: { label: "已领取", tone: "success", amount: item.claim.amount },
      payment: item.claim.payment?.status ?? null,
      self: item.claim.self === true,
    };
  const registration = item.registration;
  const outcome =
    registration.status === "won"
      ? {
          label: "已中奖",
          tone: "success" as const,
          amount: registration.claim?.amount,
        }
      : registration.status === "not_won"
        ? { label: "未中奖", tone: "neutral" as const }
        : registration.status === "drawing"
          ? { label: "开奖中", tone: "warning" as const }
          : { label: "已报名", tone: "gold" as const };
  return {
    ...base,
    verb: "报名",
    at: Date.parse(registration.registeredAt),
    outcome,
    payment:
      registration.status === "won"
        ? (registration.claim?.payment?.status ?? null)
        : null,
    self: registration.status === "won" && registration.claim?.self === true,
  };
}

/** 即将开放: timed drafts, nearest first (scheduled-opening §7). */
export type SquareFilter = "upcoming" | "active" | "ended" | "all";

/** The 红包广场, newest first, 20 at a time; `live` polls (the shown list). */
export function useSquarePages(
  status: SquareFilter,
  userId: string | null,
  live: boolean,
) {
  return useInfiniteQuery({
    queryKey: ["discovery", userId, status, "all", "pages"],
    initialPageParam: null as string | null,
    queryFn: async ({ pageParam, signal }) =>
      readResponse<DiscoveryList>(
        await api.api.discovery.activities.$get(
          {
            query: {
              status,
              type: "all",
              ...(pageParam ? { cursor: pageParam } : {}),
            },
          },
          { init: { signal, cache: "no-store" } },
        ),
      ),
    getNextPageParam: (last) => last.nextCursor,
    retry: false,
    refetchInterval: live ? 15_000 : false,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: false,
  });
}

export type SentFilter = "all" | "active" | "draft" | "finished";

/** What this account sent, newest first; every page carries the counts. */
export function useSentPages(userId: string, status: SentFilter) {
  return useInfiniteQuery({
    queryKey: [...activityKeys.mine(userId), "pages", status],
    initialPageParam: null as string | null,
    queryFn: async ({ pageParam, signal }) => {
      const query: ActivityHistoryFilters & { cursor?: string } = {
        type: "all",
        status,
        ...(pageParam ? { cursor: pageParam } : {}),
      };
      return readResponse<ActivityList>(
        await fetch(
          `/api/me/activities?${new URLSearchParams(query as Record<string, string>).toString()}`,
          { signal, cache: "no-store" },
        ),
      );
    },
    getNextPageParam: (last) => last.nextCursor,
    retry: false,
    // Another filter's rows stay, dimmed, until this one's are in — the
    // same account's only (07 §1).
    placeholderData: (previous, previousQuery) =>
      previousQuery?.queryKey[1] === userId ? previous : undefined,
    ...historyListRefreshOptions,
  });
}

/** What this account took part in, newest first. */
export function useJoinedPages(userId: string) {
  return useInfiniteQuery({
    queryKey: [...claimKeys.participations(userId), "pages"],
    initialPageParam: null as string | null,
    queryFn: async ({ pageParam, signal }) =>
      readResponse<ParticipationList>(
        await fetch(
          `/api/me/participations?${new URLSearchParams({
            type: "all",
            status: "all",
            ...(pageParam ? { cursor: pageParam } : {}),
          }).toString()}`,
          { signal, cache: "no-store" },
        ),
      ),
    getNextPageParam: (last) => last.nextCursor,
    retry: false,
    ...historyListRefreshOptions,
  });
}

/** 已结束 counts 已归档 too (07 §3). */
export function sentCounts(counts: ActivityStatusCounts | undefined) {
  return {
    all: counts?.all ?? 0,
    active: counts?.active ?? 0,
    draft: counts?.draft ?? 0,
    finished: (counts?.ended ?? 0) + (counts?.archived ?? 0),
  };
}
