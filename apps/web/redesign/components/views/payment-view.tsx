import { PAYMENT_LABELS } from "@hb/contracts";
import { useAtomValue } from "jotai";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronRight,
  Clock3,
  KeyRound,
  PauseCircle,
} from "lucide-react";
import { useIsPresent } from "motion/react";
import { type FormEvent, useId, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { findActivity } from "../../fixtures/activities";
import { findMerchant } from "../../fixtures/merchants";
import {
  type FixturePayment,
  findPayment,
  type PaymentStep,
} from "../../fixtures/payments";
import { cn } from "../../lib/cn";
import { scrollBehavior } from "../../lib/motion";
import { paymentTone } from "../../lib/my-records";
import { clockLabel, clockSeconds, fullTime } from "../../lib/roster-time";
import { sessionAtom, submitSimAtom } from "../../lib/store";
import { useOmniboxController } from "../omnibox/use-omnibox-controller";
import {
  Callout,
  InfoList,
  Page,
  PageHeader,
  PageSection,
  Panel,
} from "../page/page";
import { LeaveGuard } from "../shell/leave-guard";
import { Avatar } from "../ui/avatar";
import { Button } from "../ui/button";
import { CopyButton } from "../ui/copy-button";
import { Field, TextInput } from "../ui/field";
import { PersonName } from "../ui/person";
import { radius, Squircle } from "../ui/squircle";
import { StatusChip } from "../ui/status-chip";
import { MessageView } from "./page-stub-view";

const dotTones: Record<PaymentStep["tone"], string> = {
  done: "bg-success",
  now: "bg-warning ring-4 ring-warning-soft",
  warn: "bg-warning",
  stop: "bg-danger ring-4 ring-danger-soft",
};

/** What happened to the payment, oldest first, with where it stands now. */
export function Timeline({ steps }: { steps: PaymentStep[] }) {
  return (
    <ol className="grid">
      {steps.map((step, index) => (
        <li
          key={`${step.at}:${step.title}`}
          className="relative grid grid-cols-[1.25rem_minmax(0,1fr)] gap-x-3 pb-4 last:pb-0"
        >
          {index < steps.length - 1 && (
            <span
              aria-hidden="true"
              className="absolute top-4 bottom-0 left-[calc(0.625rem-0.5px)] w-px bg-line-strong"
            />
          )}
          <span className="flex h-6 items-center justify-center">
            <span
              aria-hidden="true"
              className={cn("size-2.5 rounded-full", dotTones[step.tone])}
            />
          </span>
          <div className="grid min-w-0 gap-0.5">
            <p className="flex flex-wrap items-baseline gap-x-2">
              <span
                className={cn(
                  "text-base font-medium",
                  step.tone === "stop" ? "text-danger" : "text-ink",
                )}
              >
                {step.title}
              </span>
              <time
                dateTime={new Date(step.at).toISOString()}
                title={fullTime(step.at)}
                className="text-xs text-ink-3 tabular-nums"
              >
                {clockSeconds(step.at)}
              </time>
            </p>
            {step.detail && <p className="text-sm text-ink-2">{step.detail}</p>}
          </div>
        </li>
      ))}
    </ol>
  );
}

/** Each request to LDC and each order check, as production's 处理记录. */
export function Attempts({
  payment,
  stacked = false,
}: {
  payment: FixturePayment;
  /** One field per line, for a narrow column (the admin detail pane). */
  stacked?: boolean;
}) {
  return (
    <Panel as="ul" className="grid px-4">
      {payment.attempts.map((attempt) => (
        <li
          key={`${attempt.at}:${attempt.action}`}
          className={cn(
            "grid gap-1 border-line border-b py-3 last:border-b-0",
            !stacked &&
              "@wide/window:grid-cols-[8.5rem_6rem_minmax(0,1fr)] @wide/window:items-baseline @wide/window:gap-4",
          )}
        >
          <time
            dateTime={new Date(attempt.at).toISOString()}
            className="text-sm text-ink-3 tabular-nums"
          >
            {clockSeconds(attempt.at)}
          </time>
          <span className="text-sm font-medium text-ink">{attempt.action}</span>
          <span className="grid gap-0.5">
            <span className="text-sm text-ink">{attempt.result}</span>
            <span className="text-xs text-ink-3">{attempt.note}</span>
          </span>
        </li>
      ))}
    </Panel>
  );
}

function MerchantFix() {
  const { leaveTo } = useOmniboxController();
  return (
    <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
      <span>到 LDC 商户配置更新密钥，检查通过后自动继续。</span>
      <Button
        size="sm"
        variant="ghost"
        className="-my-1"
        onClick={() => void leaveTo({ to: "/merchant" })}
      >
        去更新
        <ChevronRight aria-hidden="true" />
      </Button>
    </span>
  );
}

/**
 * Where the payment stands, in a sentence. `admin`: read from 网站管理,
 * where the 红包's sender is the one who can act.
 */
export function StateNote({
  payment,
  admin = false,
}: {
  payment: FixturePayment;
  admin?: boolean;
}) {
  if (payment.state === "confirmed" && payment.confirmedAt)
    return (
      <Callout tone="success" icon={CheckCircle2}>
        {clockSeconds(payment.confirmedAt)} 查单确认到账。
      </Callout>
    );
  if (payment.state === "attention")
    return (
      <Callout tone="danger" icon={AlertTriangle} title={payment.reason}>
        这笔付款不会自动重发，也不会重复付款。
      </Callout>
    );
  if (payment.state === "waiting" && payment.repairable)
    return (
      <Callout tone="warning" icon={KeyRound} title={payment.reason}>
        这笔付款用的是更换前的商户应用，它的密钥失效了。
        {admin
          ? "要等发红包的人在付款详情里更新原订单密钥后继续。"
          : "在下面“更新原订单密钥”填写它现在的密钥后继续。"}
      </Callout>
    );
  // The current merchant's 密钥 failed its check: the sender fixes it on
  // the merchant page (production: credentials / credential_rejected).
  if (payment.state === "waiting" && payment.reason?.includes("凭证"))
    return (
      <Callout tone="warning" icon={KeyRound} title={payment.reason}>
        {admin ? (
          "要等发红包的人更新商户密钥，检查通过后继续。"
        ) : (
          <MerchantFix />
        )}
      </Callout>
    );
  if (payment.state === "waiting")
    return (
      <Callout tone="warning" icon={PauseCircle} title={payment.reason}>
        条件满足后自动继续
        {payment.nextRunAt
          ? `，下次尝试约在 ${clockLabel(payment.nextRunAt)}`
          : ""}
        。不需要在这里操作。
      </Callout>
    );
  return (
    <Callout tone="warning" icon={Clock3} title={payment.reason}>
      查清之前不会重新发送，不会重复付款
      {payment.nextRunAt
        ? `；下次核对约在 ${clockLabel(payment.nextRunAt)}`
        : ""}
      。
    </Callout>
  );
}

/**
 * 更新原订单密钥: the order went out through the merchant's previous app
 * (Client ID changed since), and that app's 密钥 was rejected. Giving its
 * current 密钥 lets the site check and send the original order — never a
 * new one (production: canRepairCredentials).
 */
function RepairCredential({
  payment,
  onRepaired,
}: {
  payment: FixturePayment;
  onRepaired: () => void;
}) {
  const [secret, setSecret] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submitSim = useAtomValue(submitSimAtom);
  const failedOnce = useRef(false);
  const ids = { client: useId(), secret: useId() };
  const save = (event: FormEvent) => {
    event.preventDefault();
    if (!secret || busy) return;
    setBusy(true);
    setError(null);
    window.setTimeout(() => {
      // Dev toolbar 提交结果: the first try fails; trying again goes through.
      if (submitSim !== "ok" && !failedOnce.current) {
        failedOnce.current = true;
        setBusy(false);
        setError(
          submitSim === "throttled"
            ? "尝试过于频繁，请稍后重试。"
            : "保存没有完成：网络或服务出了问题，原订单密钥没有更新。可以再试一次。",
        );
        return;
      }
      const at = Date.now();
      // The prototype's record of the payment: back to checking the order.
      Object.assign(payment, {
        state: "reconciling",
        reason: "已更新原订单密钥，正在核对原订单。",
        repairable: false,
        nextRunAt: at + 60_000,
        steps: [
          ...payment.steps.map((step) =>
            step.tone === "now"
              ? {
                  ...step,
                  tone: "done" as const,
                  detail: "原应用的密钥失效，等待作者更新",
                }
              : step,
          ),
          {
            at,
            title: "更新原订单密钥",
            detail: "由你提交，凭证检查通过",
            tone: "done" as const,
          },
          {
            at: at + 1_000,
            title: "核对原订单",
            detail: "查清之前不会重新发送，不会重复付款",
            tone: "now" as const,
          },
        ],
      });
      setBusy(false);
      setSecret("");
      onRepaired();
    }, 800);
  };
  return (
    <PageSection
      title="更新原订单密钥"
      description="只用于这笔付款原来的商户应用，不会改动当前商户。"
    >
      <LeaveGuard
        when={secret.length > 0 && !busy}
        message="原订单密钥还没保存，离开后要重新填写。"
      />
      <Panel>
        <form className="grid gap-4 p-5" onSubmit={save} noValidate>
          <Field label="原订单 Client ID" htmlFor={ids.client}>
            <TextInput
              id={ids.client}
              mono
              readOnly
              value={payment.originalClientId ?? ""}
            />
          </Field>
          <Field
            label="原订单商户密钥"
            htmlFor={ids.secret}
            hint="在 LDC 的这个应用里查看现在的密钥。保存后自动检查，密钥不会显示出来。"
          >
            <TextInput
              id={ids.secret}
              type="password"
              autoComplete="new-password"
              value={secret}
              onChange={(event) => setSecret(event.target.value)}
            />
          </Field>
          {error && (
            <p role="alert" className="text-sm text-danger">
              {error}
            </p>
          )}
          <div>
            <Button type="submit" variant="primary" disabled={!secret || busy}>
              {busy ? "正在保存…" : "保存原订单密钥"}
            </Button>
          </div>
        </form>
      </Panel>
    </PageSection>
  );
}

/**
 * /payments/<编号> 付款详情: one payment from the account's merchant — who
 * gets it, where it stands, how it got there, and the numbers to quote when
 * asking about it. Production: the merchant payment dialog's detail and the
 * workbench's 付款详情 panel. There is no retry button: the site retries and
 * checks on its own, and never pays twice.
 */
export function PaymentView({ id }: { id: string }) {
  const user = useAtomValue(sessionAtom);
  const [, rerender] = useState(0);
  // After 保存原订单密钥 its section is gone: focus (and reading) moves to
  // the payment's new state.
  const stateRef = useRef<HTMLDivElement>(null);
  const present = useIsPresent();
  const here = useRef(present);
  here.current = present;
  const { leaveTo } = useOmniboxController();
  const payment = findPayment(id);
  const activity = payment ? findActivity(payment.activityId) : null;
  // Only the 红包's sender (or an admin, from /admin/payments) sees it.
  if (!payment || !activity || activity.author.username !== user?.username)
    return <MessageView title="未找到付款" text="付款不存在，或者不是你的。" />;
  const merchant = findMerchant(payment.merchantId);
  const verb = payment.source === "draw" ? "中奖" : "领取";

  return (
    <Page>
      <PageHeader
        eyebrow="付款记录"
        title={`付给 ${payment.recipient.displayName}`}
        description={`${activity.title} · ${clockSeconds(payment.createdAt)} ${verb}`}
      />
      <Panel className="grid gap-4 p-5">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
          <Avatar name={payment.recipient.displayName} size={48} />
          <div className="grid min-w-0 flex-1 gap-0.5">
            <p className="flex min-w-0 text-lg font-semibold text-ink">
              <PersonName
                name={payment.recipient.displayName}
                username={payment.recipient.username}
              />
            </p>
            <p className="truncate text-sm text-ink-2">
              @{payment.recipient.username}
            </p>
          </div>
          <div className="grid justify-items-end gap-1.5">
            <p className="text-2xl font-semibold text-ink tabular-nums">
              {payment.amount}
              <span className="ml-1 text-sm font-medium text-ink-3">LDC</span>
            </p>
            <StatusChip tone={paymentTone(payment.state)} dot>
              {PAYMENT_LABELS[payment.state]}
            </StatusChip>
          </div>
        </div>
        <div ref={stateRef} tabIndex={-1} className="outline-none">
          <StateNote payment={payment} />
        </div>
      </Panel>

      {payment.repairable && (
        <RepairCredential
          payment={payment}
          onRepaired={() => {
            flushSync(() => rerender((count) => count + 1));
            // Not from a page that is already leaving.
            if (!here.current) return;
            stateRef.current?.focus({ preventScroll: true });
            stateRef.current?.scrollIntoView({
              block: "nearest",
              behavior: scrollBehavior(),
            });
          }}
        />
      )}

      <PageSection title="经过">
        <Panel className="p-5">
          <Timeline steps={payment.steps} />
        </Panel>
      </PageSection>

      <PageSection
        title="订单"
        description="询问这笔付款时，提供本站业务号即可。"
      >
        <InfoList
          items={[
            {
              label: "红包",
              value: (
                <Squircle radius={radius.row}>
                  <button
                    type="button"
                    onClick={() =>
                      void leaveTo({ to: "activity", id: activity.id })
                    }
                    className="-mx-1.5 inline-flex max-w-full items-center gap-0.5 px-1.5 text-left text-ink hover:bg-fill-2"
                  >
                    <span className="truncate">{activity.title}</span>
                    <ChevronRight
                      className="size-4 shrink-0 text-ink-3"
                      aria-hidden="true"
                    />
                  </button>
                </Squircle>
              ),
            },
            {
              label: "来源",
              value: payment.source === "draw" ? "中奖" : "领取",
            },
            {
              label: "本站业务号",
              value: (
                <span className="font-mono text-sm">{payment.businessNo}</span>
              ),
              action: (
                <CopyButton value={payment.businessNo} label="本站业务号" />
              ),
            },
            {
              label: "上游交易号",
              value: payment.externalOrderId ? (
                <span className="font-mono text-sm">
                  {payment.externalOrderId}
                </span>
              ) : (
                <span className="text-ink-3">尚未收到</span>
              ),
              action: payment.externalOrderId ? (
                <CopyButton
                  value={payment.externalOrderId}
                  label="上游交易号"
                />
              ) : undefined,
            },
            {
              label: "创建时间",
              value: (
                <span title={fullTime(payment.createdAt)}>
                  {clockSeconds(payment.createdAt)}
                </span>
              ),
            },
            {
              label: "确认发放",
              value: payment.confirmedAt ? (
                clockSeconds(payment.confirmedAt)
              ) : (
                <span className="text-ink-3">尚未确认</span>
              ),
            },
            {
              label: "付款商户",
              value: merchant ? (
                <span>
                  {merchant.label}
                  <span className="ml-2 font-mono text-sm text-ink-3">
                    {payment.originalClientId ?? merchant.clientId}
                  </span>
                </span>
              ) : (
                "—"
              ),
              note: payment.originalClientId
                ? `订单用的是更换前的 Client ID；商户现在是 ${merchant?.clientId ?? "—"}。`
                : undefined,
            },
          ]}
        />
      </PageSection>

      <PageSection
        title="处理记录"
        description="本站每次向 LDC 发出的请求和查单。"
      >
        <Attempts payment={payment} />
      </PageSection>
    </Page>
  );
}
