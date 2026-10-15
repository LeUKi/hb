import { PAYMENT_LABELS } from "@hb/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useAtomValue } from "jotai";
import { AlertTriangle, ChevronRight, KeyRound, Plus } from "lucide-react";
import { type FixtureActivity, findActivity } from "../../fixtures/activities";
import { publicOf } from "../../fixtures/hongbao";
import {
  demoPayments,
  type FixturePayment,
  isOpenPayment,
  sumAmounts,
} from "../../fixtures/payments";
import { paymentTone } from "../../lib/my-records";
import { clockSeconds } from "../../lib/roster-time";
import { drawSimAtom, sessionAtom } from "../../lib/store";
import { quantityLine } from "../hongbao/hongbao-card";
import { useOmniboxController } from "../omnibox/use-omnibox-controller";
import { LazyListEnd, useLazyList } from "../page/lazy-list";
import {
  Callout,
  EmptyNote,
  Facts,
  Page,
  PageHeader,
  Panel,
} from "../page/page";
import { useSearchChoice } from "../shell/use-search-choice";
import { Avatar } from "../ui/avatar";
import { Button } from "../ui/button";
import { Segmented } from "../ui/field";
import { MiniEnvelope } from "../ui/mini-envelope";
import { radius, Squircle } from "../ui/squircle";
import { StatusChip } from "../ui/status-chip";

type Filter = "all" | "open" | "confirmed";

type Group = { activity: FixtureActivity; payments: FixturePayment[] };

function PaymentRow({ payment }: { payment: FixturePayment }) {
  const navigate = useNavigate();
  const verb = payment.source === "draw" ? "中奖" : "领取";
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
          <Avatar name={payment.recipient.displayName} size={36} />
          <span className="grid min-w-0 flex-1 gap-0.5">
            <span className="flex min-w-0 items-baseline gap-1.5">
              <span className="truncate text-base text-ink">
                {payment.recipient.displayName}
              </span>
              <span className="hidden truncate text-xs text-ink-3 @wide/window:inline">
                @{payment.recipient.username}
              </span>
            </span>
            <span className="truncate text-xs text-ink-3">
              {payment.reason ?? `${clockSeconds(payment.createdAt)} ${verb}`}
            </span>
          </span>
          <span className="grid shrink-0 justify-items-end gap-1">
            <span className="text-base font-semibold text-ink tabular-nums">
              {payment.amount}
              <span className="ml-0.5 text-xs font-medium text-ink-3">LDC</span>
            </span>
            <StatusChip tone={paymentTone(payment.state)} dot>
              {PAYMENT_LABELS[payment.state]}
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

/** A run of one 红包's payments, the newest first. */
function PaymentPanel({ payments }: { payments: FixturePayment[] }) {
  return (
    <Panel className="grid gap-0.5 p-1.5">
      <ul className="grid gap-0.5">
        {payments.map((payment) => (
          <PaymentRow key={payment.id} payment={payment} />
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
  id,
  groups,
  grouped,
}: {
  id: string;
  groups: Group[];
  grouped: boolean;
}) {
  const rows = groups.flatMap((group) =>
    group.payments.map((payment) => ({ activity: group.activity, payment })),
  );
  const list = useLazyList({ id, total: rows.length });
  const sections: Group[] = [];
  for (const { activity, payment } of rows.slice(0, list.shown)) {
    const last = sections.at(-1);
    if (last?.activity.id === activity.id) last.payments.push(payment);
    else sections.push({ activity, payments: [payment] });
  }
  return (
    <div
      className="grid gap-6 @wide/window:gap-8"
      aria-busy={list.state === "loading" || undefined}
    >
      {sections.map((section) =>
        grouped ? (
          <section key={section.activity.id} className="grid gap-2.5">
            <GroupHead activity={section.activity} />
            <PaymentPanel payments={section.payments} />
          </section>
        ) : (
          <PaymentPanel key={section.activity.id} payments={section.payments} />
        ),
      )}
      <LazyListEnd
        list={list}
        done={`共 ${rows.length} 笔`}
        className="-mt-3 @wide/window:-mt-5"
      />
    </div>
  );
}

function GroupHead({ activity }: { activity: FixtureActivity }) {
  const { leaveTo } = useOmniboxController();
  const drawSim = useAtomValue(drawSimAtom);
  const view = publicOf(activity, { solved: [], drawSim, now: Date.now() });
  const paid = demoPayments().filter(
    (payment) => payment.activityId === activity.id && !isOpenPayment(payment),
  );
  return (
    <div className="flex items-center gap-3 px-1">
      <MiniEnvelope ended={view.ended} />
      <div className="grid min-w-0 flex-1 gap-0.5">
        <h2 className="truncate text-base font-semibold text-ink">
          {activity.title}
        </h2>
        <p className="truncate text-xs text-ink-3">
          {quantityLine(activity, view)} · 已发放 {sumAmounts(paid)} LDC
        </p>
      </div>
      <Squircle radius={radius.row}>
        <button
          type="button"
          onClick={() => void leaveTo({ to: "activity", id: activity.id })}
          className="flex h-8 shrink-0 items-center gap-0.5 px-2 text-sm text-ink-2 transition-colors hover:bg-fill-2 hover:text-ink"
        >
          打开红包
          <ChevronRight className="size-4" aria-hidden="true" />
        </button>
      </Squircle>
    </div>
  );
}

/**
 * 付款记录: what the account's 红包 paid out, through its merchants. One
 * place for what production split between the merchant's payment dialog and
 * the /my/payments workbench. `activityId` narrows it to one 红包 (🧾).
 */
export function PaymentsView({ activityId }: { activityId?: string }) {
  const { leaveTo } = useOmniboxController();
  const navigate = useNavigate();
  const [filter, setFilter] = useSearchChoice<Filter>("filter", "all", [
    "all",
    "open",
    "confirmed",
  ]);
  const user = useAtomValue(sessionAtom);
  // The signed-in account's own 红包 only (the 新账号 has none).
  const all = demoPayments().filter(
    (payment) =>
      (!activityId || payment.activityId === activityId) &&
      findActivity(payment.activityId)?.author.username === user?.username,
  );
  const open = all.filter(isOpenPayment);
  const attention = all.filter((payment) => payment.state === "attention");
  const repairable = all.filter((payment) => payment.repairable);
  const shown =
    filter === "all"
      ? all
      : filter === "open"
        ? open
        : all.filter((payment) => !isOpenPayment(payment));
  const groups = [...new Set(shown.map((payment) => payment.activityId))]
    .map((id) => ({
      activity: findActivity(id),
      payments: shown.filter((payment) => payment.activityId === id),
    }))
    .filter((group): group is Group => group.activity !== null);
  const single = activityId ? findActivity(activityId) : null;

  return (
    <Page>
      <PageHeader
        refreshable
        eyebrow={single ? single.title : undefined}
        title="付款记录"
        description={
          single
            ? "这个红包付给领取人的 LDC，由你的商户应用直接发出。"
            : "你的红包付给领取人的 LDC，由你的商户应用直接发出。本站会核对每一笔，不会重复付款。"
        }
      />
      {all.length === 0 ? (
        <EmptyNote
          title="还没有付款"
          text={
            single
              ? "有人领取后，这里会出现付给领取人的那一笔。"
              : "你的红包有人领取后，这里会出现付给领取人的每一笔。"
          }
          action={
            single ? undefined : (
              <Button onClick={() => void leaveTo({ to: "/new" })}>
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
                  value: `${sumAmounts(all.filter((payment) => !isOpenPayment(payment)))} LDC`,
                  note: `${all.length - open.length} 笔`,
                },
                {
                  label: "没完成",
                  value: `${sumAmounts(open)} LDC`,
                  note:
                    attention.length > 0
                      ? `${open.length} 笔，其中 ${attention.length} 笔已暂停`
                      : `${open.length} 笔，系统会继续处理`,
                },
                {
                  label: "异常待处理",
                  value: `${attention.length} 笔`,
                  note: attention.length > 0 ? "发送已暂停" : "没有",
                },
              ]}
            />
          </Panel>
          {repairable.length > 0 && (
            <Callout
              tone="warning"
              icon={KeyRound}
              title={`有 ${repairable.length} 笔付款等你更新原订单密钥`}
            >
              <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <span>商户换过 Client ID，原应用的密钥失效了。</span>
                <Button
                  size="sm"
                  variant="ghost"
                  className="-my-1"
                  onClick={() =>
                    void navigate({
                      to: "/payments/$paymentId",
                      params: { paymentId: repairable[0]?.id ?? "" },
                    })
                  }
                >
                  去更新
                  <ChevronRight aria-hidden="true" />
                </Button>
              </span>
            </Callout>
          )}
          {attention.length > 0 && (
            <Callout
              tone="danger"
              icon={AlertTriangle}
              title={`有 ${attention.length} 笔付款发送已暂停`}
            >
              这类付款不会自动重发，也不会重复付款。点开可以看到原因和经过。
            </Callout>
          )}
          <Segmented
            label="付款状态"
            value={filter}
            onChange={setFilter}
            options={[
              { value: "all", label: "全部", count: all.length },
              { value: "open", label: "没完成", count: open.length },
              {
                value: "confirmed",
                label: "已发放",
                count: all.length - open.length,
              },
            ]}
          />
          {groups.length === 0 ? (
            <EmptyNote title="没有符合条件的付款" />
          ) : (
            <PaymentStream
              id={`payments:${filter}`}
              groups={groups}
              grouped={!single}
            />
          )}
        </>
      )}
    </Page>
  );
}
