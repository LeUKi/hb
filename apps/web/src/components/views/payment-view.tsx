import {
  type AccountPaymentDetail,
  type MerchantPaymentDetail,
  PAYMENT_LABELS,
} from "@hb/contracts";
import { useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronRight,
  Clock3,
  KeyRound,
  PauseCircle,
} from "lucide-react";
import { useIsPresent } from "motion/react";
import {
  type FormEvent,
  type ReactNode,
  type RefObject,
  useId,
  useRef,
  useState,
} from "react";
import { ActivityRequestError, refused } from "../../lib/activities";
import { cn } from "../../lib/cn";
import { paymentTone } from "../../lib/hongbao-text";
import { useMerchantIdentity, useMerchantWrites } from "../../lib/merchants";
import { scrollBehavior } from "../../lib/motion";
import { paymentReason } from "../../lib/payment-display";
import {
  confirmedBy,
  needsMerchantKey,
  type PaymentStep,
  paymentAttempts,
  paymentKeys,
  paymentSteps,
  useAccountPayment,
} from "../../lib/payments";
import { clockLabel, clockSeconds, fullTime } from "../../lib/roster-time";
import { type SessionUser, useIdentity } from "../../lib/session";
import { useOmniboxController } from "../omnibox/use-omnibox-controller";
import {
  Callout,
  InfoList,
  Page,
  PageHeader,
  PageSection,
  Panel,
} from "../page/page";
import { PageLoad, queryLoad } from "../page/page-state";
import { LeaveGuard } from "../shell/leave-guard";
import { Avatar } from "../ui/avatar";
import { Button } from "../ui/button";
import { MoreLink } from "../ui/button-link";
import { CopyButton } from "../ui/copy-button";
import { Field, TextInput } from "../ui/field";
import { PersonName } from "../ui/person";
import { Swap } from "../ui/reveal";
import { radius, Squircle } from "../ui/squircle";
import { StatusChip } from "../ui/status-chip";
import { MessageView } from "./message-view";

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
          // The last step is where it stands now (the dot's colour says the
          // same to the eye).
          aria-current={index === steps.length - 1 ? "step" : undefined}
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
  admin = false,
}: {
  payment: MerchantPaymentDetail;
  /** One field per line, for a narrow column (the admin detail pane). */
  stacked?: boolean;
  /** 网站管理: each request's HTTP status too. */
  admin?: boolean;
}) {
  const rows = paymentAttempts(payment, { admin });
  if (rows.length === 0)
    return (
      <Panel className="px-4 py-3 text-sm text-ink-3">
        还没有向 LDC 发出请求。
      </Panel>
    );
  return (
    <Panel as="ul" className="grid px-4">
      {rows.map((attempt) => (
        <li
          key={attempt.id}
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
            {attempt.note && (
              <span className="text-xs text-ink-3">{attempt.note}</span>
            )}
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
      <MoreLink
        className="-my-1"
        href="/merchant"
        onGo={() => void leaveTo({ to: "/merchant" })}
      >
        去更新
      </MoreLink>
    </span>
  );
}

/**
 * Where the payment stands, in a sentence. `admin`: read from 网站管理,
 * where the 红包's sender is the one who can act.
 */
export function StateNote(props: {
  payment: MerchantPaymentDetail;
  admin?: boolean;
}) {
  const { payment } = props;
  // A payment moving on (发放中 → 已发放) changes its note in place.
  return (
    <Swap
      id={`${payment.status}:${payment.reason ?? ""}:${payment.unknownOutcome ? 1 : 0}`}
    >
      <StateNoteBody {...props} />
    </Swap>
  );
}

function StateNoteBody({
  payment,
  admin = false,
}: {
  payment: MerchantPaymentDetail;
  admin?: boolean;
}) {
  const reason = paymentReason(payment.reason);
  if (payment.status === "confirmed")
    return (
      <Callout tone="success" icon={CheckCircle2}>
        {payment.confirmedAt
          ? `${clockSeconds(Date.parse(payment.confirmedAt))} ${confirmedBy(payment)}。`
          : `${confirmedBy(payment)}。`}
      </Callout>
    );
  if (payment.status === "attention")
    return (
      <Callout tone="danger" icon={AlertTriangle} title={reason}>
        这笔付款不会自动重发，也不会重复付款。
      </Callout>
    );
  if (payment.status === "waiting" && payment.config?.canRepairCredentials)
    return (
      <Callout tone="warning" icon={KeyRound} title={reason}>
        这笔付款用的是更换前的集市应用，它的密钥失效了。
        {admin
          ? "要等发红包的人在付款详情里更新原订单密钥后继续。"
          : "在下面“更新原订单密钥”填写它现在的密钥后继续。"}
      </Callout>
    );
  // The current merchant's 密钥 failed its check: the sender fixes it on
  // the merchant page.
  if (needsMerchantKey(payment))
    return (
      <Callout tone="warning" icon={KeyRound} title={reason}>
        {admin ? (
          "要等发红包的人更新商户密钥，检查通过后继续。"
        ) : (
          <MerchantFix />
        )}
      </Callout>
    );
  const next = payment.nextSendAt ?? payment.nextQueryAt ?? payment.nextRunAt;
  const nextAt = next ? clockLabel(Date.parse(next)) : null;
  if (payment.status === "waiting")
    return (
      <Callout tone="warning" icon={PauseCircle} title={reason}>
        条件满足后自动继续{nextAt ? `，下次尝试约在 ${nextAt}` : ""}
        。不需要在这里操作。
      </Callout>
    );
  if (payment.status === "reconciling" || payment.unknownOutcome)
    return (
      <Callout
        tone="warning"
        icon={Clock3}
        title={reason ?? "付款结果尚未明确，正在核对原订单。"}
      >
        查清之前不会重新发送，不会重复付款
        {nextAt ? `；下次核对约在 ${nextAt}` : ""}。
      </Callout>
    );
  return (
    <Callout tone="warning" icon={Clock3} title={reason ?? "正在发放"}>
      系统会自动发给 LDC，不会重复付款。
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
  detail,
  user,
  csrfToken,
  onRepaired,
}: {
  detail: AccountPaymentDetail;
  user: SessionUser;
  csrfToken: string;
  onRepaired: () => void;
}) {
  const [secret, setSecret] = useState("");
  const [error, setError] = useState<string | null>(null);
  const writes = useMerchantWrites(user.id, csrfToken, detail.merchant.id);
  const repair = writes.repairPaymentCredentials;
  const busy = repair.isPending;
  const ids = { client: useId(), secret: useId() };
  const save = (event: FormEvent) => {
    event.preventDefault();
    if (!secret || busy) return;
    setError(null);
    repair.mutate(
      {
        taskId: detail.payment.id,
        input: {
          requestId: crypto.randomUUID(),
          version: detail.merchant.version,
          secret,
        },
      },
      {
        onSuccess: () => {
          setSecret("");
          onRepaired();
        },
        onError: (failure) =>
          setError(
            failure instanceof ActivityRequestError && failure.status === 429
              ? "尝试过于频繁，请稍后再试。"
              : refused(failure) && failure.message
                ? failure.message
                : "保存没有完成：网络或服务出了问题，原订单密钥没有更新。可以再试一次。",
          ),
      },
    );
  };
  return (
    <PageSection
      title="更新原订单密钥"
      description="只用于这笔付款原来的集市应用，不会改动当前商户。"
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
              value={detail.payment.config?.effectiveClientId ?? ""}
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
            <Button
              type="submit"
              variant="primary"
              aria-disabled={!secret || busy || undefined}
              data-disabled={!secret || undefined}
            >
              {busy ? "正在保存…" : "保存原订单密钥"}
            </Button>
          </div>
        </form>
      </Panel>
    </PageSection>
  );
}

/**
 * /payments/<编号> 付款详情: one payment of the account's 红包 — who gets
 * it, where it stands, how it got there, and the numbers to quote when
 * asking about it. There is no retry button: the site retries and checks on
 * its own, and never pays twice.
 */
export function PaymentView({ id }: { id: string }) {
  const { user, csrfToken } = useIdentity();
  if (!user || !csrfToken) return null;
  return <Payment id={id} user={user} csrfToken={csrfToken} />;
}

function Payment({
  id,
  user,
  csrfToken,
}: {
  id: string;
  user: SessionUser;
  csrfToken: string;
}) {
  const queryClient = useQueryClient();
  const { identity } = useMerchantIdentity(user.id);
  const query = useAccountPayment(user.id, id);
  // After 保存原订单密钥 its section is gone: focus (and reading) moves to
  // the payment's new state.
  const stateRef = useRef<HTMLDivElement>(null);
  const present = useIsPresent();
  const here = useRef(present);
  here.current = present;
  const { leaveTo } = useOmniboxController();
  const error = query.error;
  if (
    error instanceof ActivityRequestError &&
    (error.status === 404 || error.status === 403)
  )
    return <MessageView title="未找到付款" text="付款不存在，或者不是你的。" />;
  const detail = query.data;

  return (
    <PageLoad load={queryLoad(query)}>
      {detail && (
        <PaymentPage
          detail={detail}
          stateRef={stateRef}
          repair={
            detail.payment.config?.canRepairCredentials ? (
              <RepairCredential
                detail={detail}
                user={user}
                csrfToken={csrfToken}
                onRepaired={() => {
                  void queryClient
                    .invalidateQueries({
                      queryKey: paymentKeys.detail(identity, id),
                    })
                    .then(() => {
                      // Not from a page that is already leaving.
                      if (!here.current) return;
                      stateRef.current?.focus({ preventScroll: true });
                      stateRef.current?.scrollIntoView({
                        block: "nearest",
                        behavior: scrollBehavior(),
                      });
                    });
                  void queryClient.invalidateQueries({
                    queryKey: paymentKeys.list(identity),
                  });
                }}
              />
            ) : null
          }
          onOpenActivity={() =>
            void leaveTo({ to: "activity", id: detail.activity.id })
          }
        />
      )}
    </PageLoad>
  );
}

function PaymentPage({
  detail,
  stateRef,
  repair,
  onOpenActivity,
}: {
  detail: AccountPaymentDetail;
  stateRef: RefObject<HTMLDivElement | null>;
  repair: ReactNode;
  onOpenActivity: () => void;
}) {
  const { payment, merchant, activity } = detail;
  const verb = activity.draw ? "中奖" : "领取";
  const recipient = payment.recipientProfile ?? {
    username:
      payment.usernameCorrection?.correctedUsername ??
      payment.recipientUsername ??
      payment.recipientId,
    displayName:
      payment.usernameCorrection?.correctedUsername ??
      payment.recipientUsername ??
      payment.recipientId,
    avatarUrl: null,
  };
  const orderClientId = payment.config?.effectiveClientId ?? merchant.clientId;
  const steps = paymentSteps(payment, {
    draw: activity.draw,
    recipient: recipient.displayName,
  });

  return (
    <Page>
      <PageHeader
        refreshable
        eyebrow="付款记录"
        title={`付给 ${recipient.displayName}`}
        description={`${activity.title} · ${clockSeconds(Date.parse(payment.createdAt))} ${verb}`}
      />
      <Panel className="grid gap-4 p-5">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
          <Avatar
            name={recipient.displayName}
            src={recipient.avatarUrl}
            size={48}
          />
          <div className="grid min-w-0 flex-1 gap-0.5">
            <p className="flex min-w-0 text-lg font-semibold text-ink">
              <PersonName
                name={recipient.displayName}
                username={recipient.username}
                avatarUrl={recipient.avatarUrl}
              />
            </p>
            <p className="truncate text-sm text-ink-2">@{recipient.username}</p>
          </div>
          <div className="grid justify-items-end gap-1.5">
            <p className="text-2xl font-semibold text-ink tabular-nums">
              {payment.amount}
              <span className="ml-1 text-sm font-medium text-ink-3">LDC</span>
            </p>
            <StatusChip tone={paymentTone(payment.status)} dot>
              {PAYMENT_LABELS[payment.status]}
            </StatusChip>
          </div>
        </div>
        <div ref={stateRef} tabIndex={-1} className="outline-none">
          <StateNote payment={payment} />
        </div>
      </Panel>

      {repair}

      <PageSection title="经过">
        <Panel className="p-5">
          <Timeline steps={steps} />
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
                    onClick={onOpenActivity}
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
            { label: "来源", value: verb },
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
                <span title={fullTime(Date.parse(payment.createdAt))}>
                  {clockSeconds(Date.parse(payment.createdAt))}
                </span>
              ),
            },
            {
              label: "确认发放",
              value: payment.confirmedAt ? (
                clockSeconds(Date.parse(payment.confirmedAt))
              ) : (
                <span className="text-ink-3">尚未确认</span>
              ),
            },
            {
              label: "付款商户",
              value: (
                <span>
                  {merchant.label}
                  <span className="ml-2 font-mono text-sm text-ink-3">
                    {orderClientId}
                  </span>
                </span>
              ),
              note:
                orderClientId !== merchant.clientId
                  ? `订单用的是更换前的 Client ID；商户现在是 ${merchant.clientId}。`
                  : undefined,
            },
          ]}
        />
      </PageSection>

      <PageSection
        title="处理记录"
        description={
          payment.nextAttemptsCursor
            ? "本站每次向 LDC 发出的请求和查单（最近 20 条）。"
            : "本站每次向 LDC 发出的请求和查单。"
        }
      >
        <Attempts payment={payment} />
      </PageSection>
    </Page>
  );
}
