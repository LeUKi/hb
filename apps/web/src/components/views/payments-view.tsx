import {
  type AccountPayment,
  type AccountPaymentFilter,
  type AccountPaymentGroup,
  PAYMENT_LABELS,
} from "@hb/contracts";
import { useNavigate } from "@tanstack/react-router";
import { AlertTriangle, ChevronRight, KeyRound, Plus } from "lucide-react";
import { useActivityFacts } from "../../lib/activity-facts";
import { activityPath } from "../../lib/activity-route";
import { paymentTone } from "../../lib/hongbao-text";
import { paymentReason } from "../../lib/payment-display";
import { useAccountPaymentPages } from "../../lib/payments";
import { sentRecordOf } from "../../lib/records";
import { clockSeconds } from "../../lib/roster-time";
import { type SessionUser, useSessionUser } from "../../lib/session";
import { quantityLine } from "../hongbao/hongbao-card";
import { useOmniboxController } from "../omnibox/use-omnibox-controller";
import {
  type LazyList,
  LazyListEnd,
  useQueryLazyList,
} from "../page/lazy-list";
import {
  Callout,
  EmptyNote,
  Facts,
  Page,
  PageHeader,
  Panel,
} from "../page/page";
import { PageLoad, queryLoad } from "../page/page-state";
import { useSearchChoice } from "../shell/use-search-choice";
import { Avatar } from "../ui/avatar";
import { Button } from "../ui/button";
import { MoreLink } from "../ui/button-link";
import { Segmented } from "../ui/field";
import { MiniEnvelope } from "../ui/mini-envelope";
import { radius, Squircle } from "../ui/squircle";
import { StatusChip } from "../ui/status-chip";

/** In the address as the page says it; the API's open is 未完成. */
type Filter = "all" | "open" | "confirmed";

function PaymentRow({
  payment,
  draw,
}: {
  payment: AccountPayment;
  draw: boolean;
}) {
  const navigate = useNavigate();
  const verb = draw ? "中奖" : "领取";
  const recipient = payment.recipientProfile;
  return (
    <li>
      <Squircle radius={radius.row}>
        <button
          type="button"
          onClick={() =>
            void navigate({
              to: "/payments/$paymentId",
              params: { paymentId: payment.id },
            })
          }
          className="flex w-full items-center gap-3 p-3 text-left transition-colors hover:bg-fill-2"
        >
          <Avatar
            name={recipient.displayName}
            src={recipient.avatarUrl}
            size={36}
          />
          <span className="grid min-w-0 flex-1 gap-0.5">
            <span className="flex min-w-0 items-baseline gap-1.5">
              <span className="truncate text-base text-ink">
                {recipient.displayName}
              </span>
              <span className="hidden truncate text-xs text-ink-3 @wide/window:inline">
                @{recipient.username}
              </span>
            </span>
            <span className="truncate text-xs text-ink-3">
              {payment.status !== "confirmed" && payment.reason
                ? paymentReason(payment.reason)
                : `${clockSeconds(Date.parse(payment.createdAt))} ${verb}`}
            </span>
          </span>
          <span className="grid shrink-0 justify-items-end gap-1">
            <span className="text-base font-semibold text-ink tabular-nums">
              {payment.amount}
              <span className="ml-0.5 text-xs font-medium text-ink-3">LDC</span>
            </span>
            <StatusChip tone={paymentTone(payment.status)} dot>
              {PAYMENT_LABELS[payment.status]}
            </StatusChip>
          </span>
          <ChevronRight
            className="size-5 shrink-0 text-ink-3"
            aria-hidden="true"
          />
        </button>
      </Squircle>
    </li>
  );
}

function GroupHead({
  group,
  user,
}: {
  group: AccountPaymentGroup;
  user: SessionUser;
}) {
  const { leaveTo } = useOmniboxController();
  const { activity, view } = sentRecordOf(group, {
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    avatarUrl: user.avatarUrl,
  });
  return (
    <div className="flex items-center gap-3 px-1">
      <MiniEnvelope ended={view.ended && view.endReason !== "settling"} />
      <div className="grid min-w-0 flex-1 gap-0.5">
        <h2 className="truncate text-base font-semibold text-ink">
          {group.title}
        </h2>
        <p className="truncate text-xs text-ink-3">
          {quantityLine(activity, view)} · 已发放 {group.confirmedAmount} LDC
        </p>
      </div>
      <MoreLink
        href={activityPath(group.id)}
        onGo={() => void leaveTo({ to: "activity", id: group.id })}
      >
        打开红包
      </MoreLink>
    </div>
  );
}

type Section = { activityId: string; payments: AccountPayment[] };

function SectionPanel({
  section,
  group,
}: {
  section: Section;
  group: AccountPaymentGroup | undefined;
}) {
  const draw = group?.reward?.mode === "timed_draw";
  return (
    <Panel className="grid gap-0.5 p-1.5">
      <ul className="grid gap-0.5">
        {section.payments.map((payment) => (
          <PaymentRow key={payment.id} payment={payment} draw={draw} />
        ))}
      </ul>
    </Panel>
  );
}

/**
 * The payments as one stream that loads 20 more as its end comes near. On
 * /payments it is grouped by 红包, and a group a batch cuts in two goes on
 * in the next one under the same head; on 🧾 it is the one 红包's.
 */
function PaymentStream({
  payments,
  groups,
  grouped,
  user,
  list,
  done,
}: {
  payments: AccountPayment[];
  groups: Record<string, AccountPaymentGroup>;
  grouped: boolean;
  user: SessionUser;
  list: LazyList;
  done: string;
}) {
  const sections: Section[] = [];
  for (const payment of payments) {
    const last = sections.at(-1);
    if (last?.activityId === payment.activityId) last.payments.push(payment);
    else sections.push({ activityId: payment.activityId, payments: [payment] });
  }
  return (
    <div
      className="grid gap-6 @wide/window:gap-8"
      aria-busy={list.state === "loading" || undefined}
    >
      {sections.map((section) => {
        const group = groups[section.activityId];
        // A group cut by a batch goes on under its own head: its first
        // payment tells the two apart.
        const key = `${section.activityId}:${section.payments[0]?.id}`;
        return grouped && group ? (
          <section key={key} className="grid gap-2.5">
            <GroupHead group={group} user={user} />
            <SectionPanel section={section} group={group} />
          </section>
        ) : (
          <SectionPanel key={key} section={section} group={group} />
        );
      })}
      <LazyListEnd
        list={list}
        done={done}
        className="-mt-3 @wide/window:-mt-5"
      />
    </div>
  );
}

/**
 * 付款记录: what the account's 红包 paid out, through its merchants. One
 * place for what production split between the merchant's payment dialog and
 * the /my/payments workbench. `activityId` narrows it to one 红包 (🧾).
 */
export function PaymentsView({ activityId }: { activityId?: string }) {
  const user = useSessionUser();
  if (!user) return null;
  return <Payments user={user} activityId={activityId} />;
}

function Payments({
  user,
  activityId,
}: {
  user: SessionUser;
  activityId?: string;
}) {
  const { leaveTo } = useOmniboxController();
  const navigate = useNavigate();
  const [filter, setFilter] = useSearchChoice<Filter>("filter", "all", [
    "all",
    "open",
    "confirmed",
  ]);
  const query = useAccountPaymentPages(
    user.id,
    filter as AccountPaymentFilter,
    activityId,
  );
  const list = useQueryLazyList({
    hasNextPage: query.hasNextPage,
    isFetchingNextPage: query.isFetchingNextPage,
    isFetchNextPageError: query.isFetchNextPageError,
    fetchNextPage: query.fetchNextPage,
    pageCount: query.data?.pages.length ?? 0,
  });
  const pages = query.data?.pages ?? [];
  const first = pages[0];
  const summary = first?.summary;
  const payments = pages.flatMap((page) => page.items);
  const groups = Object.assign(
    {},
    ...pages.map((page) => page.activities),
  ) as Record<string, AccountPaymentGroup>;
  const all = summary ? summary.confirmedCount + summary.openCount : 0;
  // 🧾: the 红包's title over the page (its public read is in the cache).
  const single = useActivityFacts(activityId ?? null);

  return (
    <PageLoad load={queryLoad(query)}>
      {summary && (
        <Page>
          <PageHeader
            refreshable
            eyebrow={single ? single.title : undefined}
            title="付款记录"
            description={
              activityId
                ? "这个红包付给领取人的 LDC，由你的商户应用直接发出。"
                : "你的红包付给领取人的 LDC，由你的商户应用直接发出。本站会核对每一笔，不会重复付款。"
            }
          />
          {all === 0 ? (
            <EmptyNote
              title="还没有付款"
              text={
                activityId
                  ? "有人领取后，这里会出现付给领取人的那一笔。"
                  : "你的红包有人领取后，这里会出现付给领取人的每一笔。"
              }
              action={
                activityId ? undefined : (
                  <Button
                    variant="primary"
                    onClick={() => void leaveTo({ to: "/new" })}
                  >
                    <Plus />
                    发红包
                  </Button>
                )
              }
            />
          ) : (
            <>
              <Panel className="p-5">
                <Facts
                  className="@wide/window:grid-cols-3"
                  items={[
                    {
                      label: "已发放",
                      value: `${summary.confirmedAmount} LDC`,
                      note: `${summary.confirmedCount} 笔`,
                    },
                    {
                      label: "未完成",
                      value: `${summary.openAmount} LDC`,
                      note:
                        summary.attentionCount > 0
                          ? `${summary.openCount} 笔，其中 ${summary.attentionCount} 笔已暂停`
                          : `${summary.openCount} 笔，系统会继续处理`,
                    },
                    {
                      label: "异常待处理",
                      value: `${summary.attentionCount} 笔`,
                      note: summary.attentionCount > 0 ? "发送已暂停" : "没有",
                    },
                  ]}
                />
              </Panel>
              {summary.repairableCount > 0 && summary.firstRepairableId && (
                <Callout
                  tone="warning"
                  icon={KeyRound}
                  title={`有 ${summary.repairableCount} 笔付款等你更新原订单密钥`}
                >
                  <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
                    <span>商户换过 Client ID，原应用的密钥失效了。</span>
                    <MoreLink
                      className="-my-1"
                      href={`/payments/${summary.firstRepairableId}`}
                      onGo={() =>
                        void navigate({
                          to: "/payments/$paymentId",
                          params: {
                            paymentId: summary.firstRepairableId ?? "",
                          },
                        })
                      }
                    >
                      去更新
                    </MoreLink>
                  </span>
                </Callout>
              )}
              {summary.attentionCount > 0 && (
                <Callout
                  tone="danger"
                  icon={AlertTriangle}
                  title={`有 ${summary.attentionCount} 笔付款发送已暂停`}
                >
                  这类付款不会自动重发，也不会重复付款。点开可以看到原因和经过。
                </Callout>
              )}
              <Segmented
                label="付款状态"
                value={filter}
                onChange={setFilter}
                options={[
                  { value: "all", label: "全部", count: all },
                  { value: "open", label: "未完成", count: summary.openCount },
                  {
                    value: "confirmed",
                    label: "已发放",
                    count: summary.confirmedCount,
                  },
                ]}
              />
              {payments.length === 0 ? (
                <EmptyNote title="没有符合条件的付款" text="换个筛选看看。" />
              ) : (
                <PaymentStream
                  payments={payments}
                  groups={groups}
                  grouped={!activityId}
                  user={user}
                  list={list}
                  done={`共 ${first.total} 笔`}
                />
              )}
            </>
          )}
        </Page>
      )}
    </PageLoad>
  );
}
