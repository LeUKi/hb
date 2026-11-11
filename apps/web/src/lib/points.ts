// 三方积分 on 红包站 (docs/third-party-points-design.md): the systems a
// sender may pick, one system as anyone sees it, the owner's 配置页 and
// 自检, a sender's key, and the 站长's panel. These routes are outside the
// typed client (api/src/app.ts, TS2589): plain fetch, read the same way.
import type {
  PointsSystemConfig,
  PointsSystemStatus,
  PublicPointsSystem,
} from "@hb/contracts";
import {
  keepPreviousData,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { readResponse } from "./activities";
import { useIdentity } from "./session";

export type PointsCopy = {
  intro: string;
  keyGuide: string;
  noRecipient: string;
  arrival: string;
  notAllowed: string;
  insufficient: string;
  keyInvalid: string;
};

export type PointsSystemView = PublicPointsSystem & PointsCopy;

export type PointsDetail = {
  system: PointsSystemView & {
    ownerUsername: string;
    onlineAt: number | null;
    mine: boolean;
  };
  key: PointsKeyView | null;
};

export type PointsKeyView = {
  accountId: string | null;
  accountUsername: string | null;
  status: "ok" | "invalid";
  checkedAt: number;
  updatedAt: number;
};

export type PointsOwnerView = PointsSystemView & {
  baseUrl: string;
  rate: number;
  endpointVersion: number;
  hasTestKey: boolean;
  testRecipientId: string | null;
  passed: boolean;
  passedTestId: string | null;
  lastTestStartedAt: number | null;
  submittedAt: number | null;
  reviewedAt: number | null;
  reviewNote: string | null;
  onlineAt: number | null;
  pausedBy: string | null;
  pausedAt: number | null;
  retiredAt: number | null;
  breakerUntil: number | null;
  version: number;
  createdAt: number;
  updatedAt: number;
};

export type SelfTestStep = {
  n: number;
  title: string;
  ok: boolean;
  sent: string;
  got: string;
  ms: number;
  note?: string;
};

export type SelfTestRun = {
  id: string;
  endpointVersion: number;
  baseUrl: string;
  step: number;
  status: "running" | "passed" | "failed";
  steps: SelfTestStep[];
  startedAt: number;
  finishedAt: number | null;
};

export type PointsBalance =
  | {
      kind: "ok";
      available: number;
      accountId: string;
      accountUsername: string;
      key: PointsKeyView | null;
    }
  | {
      kind: "no_key" | "key_invalid" | "unreachable";
      key: PointsKeyView | null;
    };

export const statusWords: Record<PointsSystemStatus, string> = {
  draft: "草稿",
  reviewing: "待审核",
  online: "已上线",
  paused: "已暂停",
  retired: "已下架",
};

export const pointsKeys = {
  online: ["points", "online"] as const,
  detail: (id: string, userId: string | null) =>
    ["points", "detail", id, userId ?? "guest"] as const,
  mine: (userId: string) => ["points", userId, "mine"] as const,
  own: (userId: string, id: string) => ["points", userId, "own", id] as const,
  balance: (userId: string, id: string) =>
    ["points", userId, "balance", id] as const,
  admin: ["points", "admin"] as const,
  adminOne: (id: string) => ["points", "admin", id] as const,
  records: (
    scope: RecordsScope,
    id: string,
    kind: "payouts" | "calls",
    filter: PayoutFilter,
  ) => ["points", "records", scope, id, kind, filter] as const,
};

async function get<T>(path: string, signal?: AbortSignal) {
  return readResponse<T>(
    await fetch(`/api/${path}`, {
      signal,
      cache: "no-store",
      credentials: "same-origin",
    }),
  );
}

function useSend() {
  const { csrfToken } = useIdentity();
  return async <T>(
    method: "POST" | "PATCH" | "PUT" | "DELETE",
    path: string,
    body?: unknown,
  ) =>
    readResponse<T>(
      await fetch(`/api/${path}`, {
        method,
        credentials: "same-origin",
        headers: {
          "X-CSRF-Token": csrfToken ?? "",
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );
}

/** The form's choices: the switch, and the systems online (§8). */
export function useOnlinePoints(enabled = true) {
  return useQuery({
    queryKey: pointsKeys.online,
    queryFn: ({ signal }) =>
      get<{ enabled: boolean; items: PointsSystemView[] }>("points", signal),
    enabled,
    staleTime: 60_000,
  });
}

/** One system as anyone sees it, with the viewer's own key (§9). */
export function usePointsDetail(id: string) {
  const { user } = useIdentity();
  return useQuery({
    queryKey: pointsKeys.detail(id, user?.id ?? null),
    queryFn: ({ signal }) =>
      get<PointsDetail>(`points/${encodeURIComponent(id)}`, signal),
    enabled: id !== "",
    staleTime: 60_000,
  });
}

export function useMyPoints(userId: string) {
  return useQuery({
    queryKey: pointsKeys.mine(userId),
    queryFn: ({ signal }) =>
      get<{
        items: PointsOwnerView[];
        plus: boolean;
        canAdd: boolean;
        max: number;
      }>("me/points", signal),
    enabled: userId !== "",
  });
}

export function useOwnPoints(userId: string, id: string) {
  return useQuery({
    queryKey: pointsKeys.own(userId, id),
    queryFn: ({ signal }) =>
      get<{ system: PointsOwnerView; tests: SelfTestRun[] }>(
        `me/points/${encodeURIComponent(id)}`,
        signal,
      ),
    enabled: userId !== "" && id !== "",
  });
}

/** 额度 now with one's saved key (§8): asked when shown, never by itself. */
export function usePointsBalance(userId: string, id: string, enabled = true) {
  return useQuery({
    queryKey: pointsKeys.balance(userId, id),
    queryFn: ({ signal }) =>
      get<PointsBalance>(`me/points/${encodeURIComponent(id)}/balance`, signal),
    enabled: enabled && userId !== "" && id !== "",
    staleTime: 30_000,
    placeholderData: keepPreviousData,
    retry: false,
  });
}

/** The owner's writes; each answers with the system, and lists read again. */
export function usePointsOwnerActions(userId: string) {
  const send = useSend();
  const queryClient = useQueryClient();
  const settle = (system?: PointsOwnerView) => {
    void queryClient.invalidateQueries({ queryKey: pointsKeys.mine(userId) });
    if (system)
      void queryClient.invalidateQueries({
        queryKey: pointsKeys.own(userId, system.id),
      });
    void queryClient.invalidateQueries({ queryKey: pointsKeys.online });
  };
  return {
    create: useMutation({
      mutationFn: (config: PointsSystemConfig) =>
        send<{ system: PointsOwnerView }>("POST", "me/points", config),
      onSuccess: ({ system }) => settle(system),
    }),
    update: useMutation({
      mutationFn: (input: {
        id: string;
        version: number;
        config: PointsSystemConfig;
      }) =>
        send<{ system: PointsOwnerView }>(
          "PATCH",
          `me/points/${encodeURIComponent(input.id)}`,
          { version: input.version, config: input.config },
        ),
      onSuccess: ({ system }) => settle(system),
    }),
    selfTest: useMutation({
      mutationFn: (input: {
        id: string;
        testKey?: string;
        testRecipientId: number;
      }) =>
        send<{
          test: { id: string; passed: boolean; steps: SelfTestStep[] };
          system: PointsOwnerView;
        }>("POST", `me/points/${encodeURIComponent(input.id)}/self-test`, {
          ...(input.testKey ? { testKey: input.testKey } : {}),
          testRecipientId: input.testRecipientId,
        }),
      onSuccess: ({ system }) => settle(system),
    }),
    act: useMutation({
      mutationFn: (input: {
        id: string;
        action: "submit" | "pause" | "resume" | "retire";
      }) =>
        send<{ system: PointsOwnerView }>(
          "POST",
          `me/points/${encodeURIComponent(input.id)}/${input.action}`,
        ),
      onSuccess: ({ system }) => settle(system),
    }),
  };
}

/** A sender's key (§8): paste or replace, and remove. */
export function usePointsKeyActions(userId: string, systemId: string) {
  const send = useSend();
  const queryClient = useQueryClient();
  const settle = () => {
    void queryClient.invalidateQueries({
      queryKey: ["points", "detail", systemId],
    });
    void queryClient.invalidateQueries({
      queryKey: pointsKeys.balance(userId, systemId),
    });
  };
  return {
    save: useMutation({
      mutationFn: (key: string) =>
        send<{ key: PointsKeyView; available: number }>(
          "PUT",
          `me/points/${encodeURIComponent(systemId)}/key`,
          { key },
        ),
      onSuccess: settle,
    }),
    remove: useMutation({
      mutationFn: () =>
        send<{ removed: boolean }>(
          "DELETE",
          `me/points/${encodeURIComponent(systemId)}/key`,
        ),
      onSuccess: settle,
    }),
  };
}

export type AdminPointsRow = PointsOwnerView & {
  ownerUsername: string;
  missedInRow: number;
  today: {
    calls: Partial<Record<"balance" | "transfer" | "query", number>>;
    total: number;
    answeredRate: number | null;
    averageMs: number | null;
  };
  openHongbao: number;
  unseenChanges: number;
  attention: number;
};

export type AdminPayout = {
  id: string;
  activityId: string;
  title: string;
  recipientUsername: string;
  amountMinor: number;
  outTradeNo: string;
  status: string;
  reason: string | null;
  attempts: number;
  misses: number;
  createdAt: number;
  updatedAt: number;
};

export type AdminPointsDetail = {
  system: PointsOwnerView & { ownerUsername: string };
  tests: SelfTestRun[];
  changes: {
    id: string;
    field: string;
    before: string;
    after: string;
    createdAt: number;
    seenAt: number | null;
    username: string;
  }[];
  attention: AdminPayout[];
  failures: { reason: string; count: number }[];
  recentFailures: AdminPayout[];
};

export function useAdminPoints() {
  return useQuery({
    queryKey: pointsKeys.admin,
    queryFn: ({ signal }) =>
      get<{
        settings: { enabled: boolean; version: number; updatedAt: number };
        systems: AdminPointsRow[];
      }>("admin/points", signal),
  });
}

export function useAdminPointsDetail(id: string) {
  return useQuery({
    queryKey: pointsKeys.adminOne(id),
    queryFn: ({ signal }) =>
      get<AdminPointsDetail>(`admin/points/${encodeURIComponent(id)}`, signal),
    enabled: id !== "",
  });
}

export function useAdminPointsActions() {
  const send = useSend();
  const queryClient = useQueryClient();
  const settle = () => {
    void queryClient.invalidateQueries({ queryKey: ["points"] });
    void queryClient.invalidateQueries({ queryKey: ["session"] });
  };
  return {
    settings: useMutation({
      mutationFn: (input: { enabled: boolean; version: number }) =>
        send("PATCH", "admin/points/settings", input),
      onSuccess: settle,
    }),
    review: useMutation({
      mutationFn: (input: { id: string; approve: boolean; note: string }) =>
        send("POST", `admin/points/${encodeURIComponent(input.id)}/review`, {
          approve: input.approve,
          note: input.note,
        }),
      onSuccess: settle,
    }),
    act: useMutation({
      mutationFn: (input: {
        id: string;
        action: "pause" | "resume" | "retire";
      }) =>
        send(
          "POST",
          `admin/points/${encodeURIComponent(input.id)}/${input.action}`,
        ),
      onSuccess: settle,
    }),
    seen: useMutation({
      mutationFn: (id: string) =>
        send("POST", `admin/points/${encodeURIComponent(id)}/changes/seen`),
      onSuccess: settle,
    }),
    payout: useMutation({
      mutationFn: (input: { id: string; action: "requery" | "fail" }) =>
        send(
          "POST",
          `admin/points/payouts/${encodeURIComponent(input.id)}/${input.action}`,
        ),
      onSuccess: settle,
    }),
  };
}

/** Why a payout stopped, for the 站长 and the issuer (§7). */
export const payoutReasonWords: Record<string, string> = {
  insufficient: "余额不够",
  key_invalid: "密钥无效",
  key_removed: "密钥删了",
  no_recipient: "找不到收款人",
  not_allowed: "不允许",
  bad_request: "参数不对",
  conflict: "单号冲突",
  network: "连不上",
  stopped: "红包已停",
  retired: "已下架",
  admin: "站长标为未发出",
  mismatch: "回复对不上",
  final_query: "等最后一次查单",
};

/** Whose view of the records: the 站长's panel or the issuer's own page. */
export type RecordsScope = "admin" | "own";
export type PayoutFilter = "all" | "confirmed" | "waiting" | "failed";

/** One payout in 发放记录 (§7). */
export type PayoutRecord = {
  id: string;
  activityId: string;
  title: string;
  authorUsername: string;
  recipientUsername: string;
  /** The recipient's LINUX DO ID, as the issuer got it. */
  recipientId: string;
  amountMinor: number;
  outTradeNo: string;
  tradeNo: string | null;
  status: "pending" | "sending" | "held" | "unknown" | "confirmed" | "failed";
  reason: string | null;
  attempts: number;
  misses: number;
  resent: boolean;
  createdAt: number;
  updatedAt: number;
  doneAt: number | null;
};

type Totals = Record<
  "confirmed" | "waiting" | "failed",
  { count: number; amountMinor: number }
>;
export type PayoutTotals = { today: Totals; week: Totals };

/** One call to the issuer in 调用记录 (§7). */
export type CallRecord = {
  id: string;
  kind: "balance" | "transfer" | "query";
  /** The issuer's result, or "missed:<why>" when there was no answer. */
  result: string;
  httpStatus: number | null;
  ms: number;
  at: number;
  outTradeNo: string | null;
};

const recordsPath = (scope: RecordsScope, id: string) =>
  `${scope === "admin" ? "admin" : "me"}/points/${encodeURIComponent(id)}/records`;

/** 发放记录, 50 at a time; the first page carries the totals. */
export function usePayoutRecords(
  scope: RecordsScope,
  id: string,
  filter: PayoutFilter,
) {
  return useInfiniteQuery({
    queryKey: pointsKeys.records(scope, id, "payouts", filter),
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) =>
      get<{
        items: PayoutRecord[];
        next: string | null;
        totals: PayoutTotals | null;
      }>(
        `${recordsPath(scope, id)}?filter=${filter}${pageParam ? `&before=${encodeURIComponent(pageParam)}` : ""}`,
        signal,
      ),
    getNextPageParam: (last) => last.next,
    enabled: id !== "",
  });
}

/** 调用记录, 50 at a time. */
export function useCallRecords(scope: RecordsScope, id: string) {
  return useInfiniteQuery({
    queryKey: pointsKeys.records(scope, id, "calls", "all"),
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) =>
      get<{ items: CallRecord[]; next: string | null }>(
        `${recordsPath(scope, id)}?kind=calls${pageParam ? `&before=${encodeURIComponent(pageParam)}` : ""}`,
        signal,
      ),
    getNextPageParam: (last) => last.next,
    enabled: id !== "",
  });
}

/** Why a payout of a 三方积分 did not go, in the claimant's words (§5 §9). */
export function pointsFailureWords(
  reason: string | null,
  system: { name: string; host: string; notAllowed?: string },
) {
  switch (reason) {
    case "insufficient":
      return `发红包的人在 ${system.host} 的余额不够了，这笔没发出去，红包也结束了。`;
    case "key_invalid":
    case "key_removed":
      return `发红包的人在 ${system.host} 的密钥失效了，这笔没发出去，红包也结束了。`;
    case "stopped":
      return "这个红包因为发不出去已经结束，这笔没有发出。";
    case "retired":
      return `「${system.name}」已经下架，这笔没有发出。`;
    case "not_allowed":
      return system.notAllowed || `${system.host} 不允许给你发这笔。`;
    case "bad_request":
    case "conflict":
      return `${system.host} 拒绝了这笔，站长会去核对。`;
    case "network":
      return `一直连不上 ${system.host}，这笔没发出去。`;
    case "admin":
      return "站长核对后确认这笔没有发出。";
    case "unknown":
      return `还不知道 ${system.host} 有没有收到这笔，站长会去核对。`;
    default:
      return null;
  }
}
