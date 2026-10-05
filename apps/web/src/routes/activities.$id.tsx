import { createFileRoute, Link } from "@tanstack/react-router";
import { useAtom } from "jotai";
import { ActivityErrorView } from "../components/activities/activity-error";
import { ClaimEntry } from "../components/activities/claim-entry";
import { DrawSummaryPanel } from "../components/activities/draw-summary";
import { ExchangeScope } from "../components/activities/exchange-scope";
import { SafeMarkdown } from "../components/activities/markdown";
import { PasswordPanel } from "../components/activities/password-panel";
import { RealPaymentNotice } from "../components/activities/real-payment-notice";
import { PublicRecipients } from "../components/activities/recipient-lists";
import { Button } from "../components/ui/button";
import { UserIdentity } from "../components/user-identity";
import {
  formatTime,
  quantityText,
  statusLabels,
  usePublicActivity,
} from "../lib/activities";
import { getLoginHref, useSession } from "../lib/auth";
import { exchangeContextAtom } from "../lib/discovery";

export const Route = createFileRoute("/activities/$id")({
  component: PublicActivityPage,
});

function PublicActivityPage() {
  const { id } = Route.useParams();
  const session = useSession();
  const [exchange, setExchange] = useAtom(exchangeContextAtom);
  const query = usePublicActivity(
    id,
    session.error ? null : (session.data?.user?.id ?? null),
    !session.isPending && !session.isError,
  );
  if (session.isError)
    return (
      <ActivityErrorView
        error={session.error}
        retry={() => session.refetch()}
      />
    );
  if (session.isPending || query.isPending)
    return <p role="status">正在读取活动…</p>;
  if (query.isError)
    return (
      <ActivityErrorView error={query.error} retry={() => query.refetch()} />
    );
  const activity = query.data.activity;
  const quantity = quantityText(activity.quantity);
  const fromMatching =
    exchange?.userId === session.data?.user?.id &&
    exchange?.selectedActivityId === activity.id;
  return (
    <>
      <ExchangeScope title={activity.title} onReturn={() => setExchange(null)}>
        {fromMatching && exchange?.resultId ? (
          <Link to="/" className="shrink-0 underline underline-offset-4">
            返回匹配列表
          </Link>
        ) : null}
      </ExchangeScope>
      <article className="activity-panel space-y-6">
        <header className="space-y-3">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <h1 className="min-w-0 break-words text-2xl font-semibold">
              {activity.title}
            </h1>
            <span className="rounded bg-neutral-100 px-2 py-1 text-sm">
              {statusLabels[activity.status]}
            </span>
          </div>
          <div className="flex flex-wrap items-center gap-2 text-sm text-neutral-600">
            <span>发放者：</span>
            <UserIdentity profile={activity.author} />
            <span>·</span>
            <span>
              {activity.rewardType === "ldc"
                ? activity.paymentMode === "real"
                  ? "LDC（真实）"
                  : "LDC（本地模拟）"
                : "文本奖励"}
            </span>
          </div>
          {activity.status === "draft" ? (
            <p className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
              准备中预览，仅作者可见。
            </p>
          ) : null}
          <p className="text-sm text-neutral-600">
            截止：{formatTime(activity.deadlineAt)}
          </p>
          {quantity ? <p className="text-sm">{quantity}</p> : null}
          {activity.draw ? <DrawSummaryPanel draw={activity.draw} /> : null}
          {activity.forceDedicated ? (
            <p className="text-sm text-neutral-600">本活动仅支持专属页兑换。</p>
          ) : null}
          {activity.topicUrl ? (
            <a
              href={activity.topicUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-block text-sm underline underline-offset-4"
            >
              查看关联帖子
            </a>
          ) : null}
        </header>
        {activity.rewardType === "ldc" && activity.paymentMode === "real" ? (
          <RealPaymentNotice
            draft={activity.status === "draft"}
            openingBlockedReason={activity.openingBlockedReason}
          />
        ) : activity.rewardType === "ldc" ? (
          <p className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm leading-6 text-amber-900">
            本活动使用本地模拟付款，不进行真实 LDC
            转账。领取成功后金额固定，付款可能排队。
          </p>
        ) : null}
        {activity.beforeInfo ? (
          <section className="space-y-3 border-t border-neutral-200 pt-5">
            <h2 className="font-semibold">领取前说明</h2>
            <SafeMarkdown>{activity.beforeInfo}</SafeMarkdown>
          </section>
        ) : null}
        {activity.afterEndInfo ? (
          <section className="space-y-3 border-t border-neutral-200 pt-5">
            <h2 className="font-semibold">结束后说明</h2>
            <SafeMarkdown>{activity.afterEndInfo}</SafeMarkdown>
          </section>
        ) : null}
        {session.data?.user && session.data.csrfToken ? (
          <section className="border-t border-neutral-200 pt-5">
            <ClaimEntry
              key={`${session.data.user.id}-${activity.id}`}
              activity={activity}
              userId={session.data.user.id}
              csrfToken={session.data.csrfToken}
              initialPassword={fromMatching ? exchange?.password : undefined}
            />
          </section>
        ) : activity.status === "active" ? (
          <section className="space-y-3 border-t border-neutral-200 pt-5">
            <p className="text-sm text-neutral-600">
              登录后可提交口令领取奖励。
            </p>
            <Button asChild>
              <a href={getLoginHref(`/activities/${activity.id}`)}>
                登录 Linux DO 账号
              </a>
            </Button>
          </section>
        ) : null}
        <PasswordPanel
          key={(session.data?.user?.id ?? "guest") + activity.id}
          activity={activity}
          userId={session.data?.user?.id ?? null}
          csrfToken={session.data?.csrfToken ?? null}
        />
        <PublicRecipients
          key={activity.id}
          id={activity.id}
          enabled={activity.showRecipientList}
        />
      </article>
    </>
  );
}
