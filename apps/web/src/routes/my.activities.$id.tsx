import {
  formatAmount,
  ldcTotalMinor,
  type ManagedActivity,
} from "@hb/contracts";
import {
  createFileRoute,
  Link,
  Outlet,
  useMatchRoute,
  useNavigate,
} from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { ActivityErrorView } from "../components/activities/activity-error";
import { ActivityForm } from "../components/activities/activity-form";
import { DrawSummaryPanel } from "../components/activities/draw-summary";
import { RandomMoneySummary } from "../components/activities/random-money-summary";
import { RealPaymentNotice } from "../components/activities/real-payment-notice";
import {
  AuthorClaims,
  AuthorRegistrations,
} from "../components/activities/recipient-lists";
import { RequireAccount } from "../components/activities/require-account";
import { Button } from "../components/ui/button";
import {
  formatTime,
  statusLabels,
  useActivityWrites,
  useManagedActivity,
} from "../lib/activities";
import { useActivityOpening } from "../lib/activity-opening";
import { publicationReason } from "../lib/payment-display";

export const Route = createFileRoute("/my/activities/$id")({
  component: ManageActivityPage,
});

function ManageActivityPage() {
  const matchRoute = useMatchRoute();
  const { id } = Route.useParams();
  if (matchRoute({ to: "/my/activities/$id/statistics", fuzzy: true }))
    return <Outlet />;
  return (
    <RequireAccount>
      {({ userId, csrfToken }) => (
        <LoadManagedActivity
          key={`${userId}-${id}`}
          userId={userId}
          csrfToken={csrfToken}
          id={id}
        />
      )}
    </RequireAccount>
  );
}

function LoadManagedActivity({
  userId,
  csrfToken,
  id,
}: {
  userId: string;
  csrfToken: string;
  id: string;
}) {
  const query = useManagedActivity(userId, id);
  if (query.isPending) return <p role="status">正在读取活动…</p>;
  if (query.isError)
    return (
      <ActivityErrorView error={query.error} retry={() => query.refetch()} />
    );
  return (
    <ManageActivity
      userId={userId}
      csrfToken={csrfToken}
      initial={query.data.activity}
      reload={async () => {
        const result = await query.refetch();
        if (result.data) return result.data.activity;
        throw result.error ?? new Error("刷新失败");
      }}
    />
  );
}

function ManageActivity({
  userId,
  csrfToken,
  initial,
  reload,
}: {
  userId: string;
  csrfToken: string;
  initial: ManagedActivity;
  reload: () => Promise<ManagedActivity>;
}) {
  const [activity, setActivity] = useState(initial);
  const [editing, setEditing] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const writes = useActivityWrites(userId, csrfToken, activity.id);
  const opening = useActivityOpening(userId, csrfToken);
  const navigate = useNavigate();
  const active = useRef(true);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  const busy =
    opening.isPending || writes.end.isPending || writes.remove.isPending;
  const openingBlocked =
    activity.openingBlockedReason === "REAL_LDC_NOT_ENABLED" ||
    activity.openingBlockedReason === "MERCHANT_LEGACY";
  const openingNeedsCheck =
    Boolean(activity.openingBlockedReason) && !openingBlocked;
  useEffect(() => {
    if (!editing)
      setActivity((previous) =>
        initial.version >= previous.version ? initial : previous,
      );
  }, [initial, editing]);
  async function open() {
    if (openingBlocked) return;
    setMessage(null);
    try {
      const result = await opening.open(activity);
      if (!active.current) return;
      setActivity(result);
      setMessage("活动已开放。");
    } catch (error) {
      if (
        !active.current ||
        (error instanceof DOMException && error.name === "AbortError")
      )
        return;
      setMessage(error instanceof Error ? error.message : "开放失败，请重试。");
      // Opening can initiate a credential check. Refresh its persisted status
      // immediately so the button cannot keep issuing requests while checking.
      if (openingNeedsCheck) {
        try {
          setActivity(await reload());
        } catch {
          // The request result remains visible; the normal query can retry.
        }
      }
    }
  }
  async function remove() {
    if (!window.confirm("确定删除这个准备中的活动吗？删除后不能恢复。")) return;
    setMessage(null);
    try {
      await writes.remove.mutateAsync({ version: activity.version });
      if (active.current) await navigate({ to: "/my/activities" });
    } catch (error) {
      if (!active.current) return;
      setMessage(
        error instanceof Error
          ? error.message
          : "删除失败，请刷新最新状态后重试。",
      );
    }
  }
  async function refresh() {
    if (editing && !window.confirm("刷新将放弃当前未保存的编辑，确定刷新吗？"))
      return;
    setRefreshing(true);
    try {
      setActivity(await reload());
      setEditing(false);
      setMessage("已读取最新版本。");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "刷新失败");
    } finally {
      setRefreshing(false);
    }
  }
  async function end() {
    if (!window.confirm("确定提前结束活动吗？结束后不能重新开放。")) return;
    setMessage(null);
    try {
      const result = await writes.end.mutateAsync({
        version: activity.version,
      });
      setActivity(result.activity);
      setMessage("活动已结束，不能重新开放。");
    } catch (error) {
      setMessage(
        error instanceof Error
          ? error.message
          : "结束失败，请刷新活动状态后重试。",
      );
    }
  }
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold">管理活动</h1>
        <Link
          to="/my/activities"
          className="text-sm underline underline-offset-4"
        >
          我的活动
        </Link>
      </div>
      <section className="activity-panel space-y-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <h2 className="min-w-0 break-words text-xl font-semibold">
            {activity.title}
          </h2>
          <span className="rounded bg-neutral-100 px-2 py-1 text-sm">
            {statusLabels[activity.status]}
          </span>
        </div>
        <dl className="grid gap-3 text-sm sm:grid-cols-3">
          <div>
            <dt className="text-neutral-500">奖励</dt>
            <dd className="mt-1">
              {activity.totalCount} 份
              {activity.rewardType === "ldc"
                ? activity.paymentMode === "real"
                  ? " LDC（真实）"
                  : " LDC（本地模拟）"
                : "文本"}
            </dd>
          </div>
          {activity.config.rewardType === "ldc" ? (
            <div>
              <dt className="text-neutral-500">总发放金额</dt>
              <dd className="mt-1">
                {formatAmount(ldcTotalMinor(activity.config))} LDC
              </dd>
            </div>
          ) : null}
          <div>
            <dt className="text-neutral-500">首次开放</dt>
            <dd className="mt-1">{formatTime(activity.openedAt)}</dd>
          </div>
          <div>
            <dt className="text-neutral-500">截止时间</dt>
            <dd className="mt-1">{formatTime(activity.deadlineAt)}</dd>
          </div>
        </dl>
        {activity.draw ? <DrawSummaryPanel draw={activity.draw} /> : null}
        {activity.rewardType === "ldc" && activity.paymentMode === "real" ? (
          <RealPaymentNotice draft={activity.status === "draft"} />
        ) : null}
        {activity.config.rewardType === "ldc" &&
        activity.config.money.mode === "random" ? (
          <RandomMoneySummary
            money={activity.config.money}
            opened={activity.status !== "draft"}
          />
        ) : null}
        <p className="break-all text-xs text-neutral-500">
          活动 ID：{activity.id}
        </p>
        <div className="flex flex-wrap gap-2">
          <Button asChild variant="secondary">
            <Link to="/activities/$id" params={{ id: activity.id }}>
              {activity.status === "draft" ? "预览专属页" : "查看专属页"}
            </Link>
          </Button>
          <Button
            type="button"
            variant="secondary"
            disabled={editing || busy}
            onClick={() => {
              setEditing(true);
              setMessage(null);
            }}
          >
            编辑活动
          </Button>
          <Button
            type="button"
            variant="secondary"
            disabled={refreshing || busy}
            onClick={() => void refresh()}
          >
            {refreshing ? "正在刷新…" : "刷新最新版本"}
          </Button>
          {activity.status === "draft" ? (
            <Button
              type="button"
              disabled={editing || busy || openingBlocked}
              onClick={() => void open()}
            >
              {opening.phase === "checking"
                ? "正在检查凭证…"
                : opening.isPending
                  ? "正在开放…"
                  : openingNeedsCheck
                    ? "检查凭证并开放"
                    : "开放领取"}
            </Button>
          ) : null}
          {activity.status === "draft" ? (
            <Button
              type="button"
              variant="secondary"
              disabled={editing || busy}
              onClick={() => void remove()}
            >
              {writes.remove.isPending ? "正在删除…" : "删除草稿"}
            </Button>
          ) : null}
          {activity.status === "active" && activity.claimedCount === 0 ? (
            <Button
              type="button"
              variant="secondary"
              disabled={editing || busy}
              onClick={() => void end()}
            >
              {writes.end.isPending ? "正在结束…" : "提前结束"}
            </Button>
          ) : null}
          {activity.config.forceDedicated ? (
            <Button asChild variant="secondary">
              <Link
                to="/my/activities/$id/statistics"
                params={{ id: activity.id }}
              >
                查看尝试统计
              </Link>
            </Button>
          ) : null}
        </div>
        {activity.status === "draft" ? (
          <p className="text-sm text-neutral-600">
            {openingBlocked
              ? publicationReason(activity.openingBlockedReason)
              : "准备中仅你可预览。开放后奖励配置将锁定，关联帖子或回复仍可修改。"}
          </p>
        ) : null}
        {activity.status === "draft" && activity.config.rewardType === "ldc" ? (
          <Link
            to="/my/merchants/$id"
            params={{ id: activity.config.merchantId }}
            className="inline-block text-sm underline underline-offset-4"
          >
            检查发放商户凭证
          </Link>
        ) : null}
      </section>
      {message ? (
        <p
          role="status"
          className="rounded-md border border-neutral-200 bg-white p-3 text-sm"
        >
          {message}
        </p>
      ) : null}
      {editing ? (
        <ActivityForm
          key={`${activity.id}-${activity.version}`}
          userId={userId}
          csrfToken={csrfToken}
          initial={activity}
          onSaved={(savedActivity) => {
            setActivity(savedActivity);
            setEditing(false);
            setMessage("修改已保存。");
          }}
        />
      ) : null}
      {activity.draw ? (
        <AuthorRegistrations
          key={`registrations-${userId}-${activity.id}`}
          userId={userId}
          id={activity.id}
        />
      ) : null}
      <AuthorClaims
        key={`claims-${userId}-${activity.id}`}
        userId={userId}
        id={activity.id}
      />
    </div>
  );
}
