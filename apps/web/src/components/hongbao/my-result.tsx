import {
  PAYMENT_LABELS,
  type PaymentState,
  type PaymentView,
} from "@hb/contracts";
import { ArrowUpRight, Lock, UserRoundX } from "lucide-react";
import { motion } from "motion/react";
import { type Ref, useState } from "react";
import { ActivityRequestError } from "../../lib/activities";
import { useResendPayment } from "../../lib/claims";
import type { HongbaoActivity, Mine } from "../../lib/hongbao";
import { paymentTone } from "../../lib/hongbao-text";
import { paymentReason, quotaResumeWords } from "../../lib/payment-display";
import { clockLabel, clockSeconds } from "../../lib/roster-time";
import { useIdentity } from "../../lib/session";
import { useBefore } from "../../lib/use-before";
import { Callout } from "../page/page";
import { Avatar } from "../ui/avatar";
import { Button } from "../ui/button";
import { ButtonLink } from "../ui/button-link";
import { NoteMarkdown } from "../ui/markdown";
import { PersonName } from "../ui/person";
import { Squircle } from "../ui/squircle";
import { StatusChip } from "../ui/status-chip";
import { Countdown } from "./cover-data";
import { CountUp } from "./parts";
import { PasswordText, RevealToggle } from "./password-text";
import { TitleBadges } from "./title-badge";
import { useNow } from "./use-hongbao";

function PaymentStatus({ state }: { state: PaymentState }) {
  return (
    <StatusChip size="md" tone={paymentTone(state)} dot>
      {PAYMENT_LABELS[state]}
    </StatusChip>
  );
}

// The claimant's side of a payment that is held up, when the server gives
// no reason (or one with no words of its own).
const paymentReasons: Partial<Record<PaymentState, string>> = {
  reconciling: "付款结果尚未明确，正在核对原订单。",
  waiting: "商户资金不足，等待补足后恢复。",
  attention: "发送已暂停，等待发红包的人处理。",
};

/** Under the status: why it waits, or when it was confirmed. */
function PaymentNote({
  payment,
  resending,
}: {
  payment: PaymentView;
  /** Sent again from this card, and not through yet. */
  resending: boolean;
}) {
  const text =
    payment.status === "confirmed"
      ? payment.confirmedAt
        ? `${clockSeconds(Date.parse(payment.confirmedAt))} 确认到账`
        : null
      : resending || payment.reason === "resend"
        ? "正在重新发送，稍等十几秒。"
        : payment.reason === "quota"
          ? `发红包的人今天在 Credit 的发放额度用完了，${quotaResumeWords(payment.quotaResumeAt)}自动继续发放。`
          : (paymentReason(payment.reason, null) ??
            paymentReasons[payment.status]);
  return text ? <p className="text-sm text-ink-2">{text}</p> : null;
}

/** Where a LINUX DO Credit account is opened. */
const CREDIT_URL = "https://credit.linux.do";

/** 收款人不存在: the upstream knows no Credit account for the viewer. */
const heldForAccount = (payment: PaymentView) =>
  payment.status === "attention" && payment.reason === "recipient";

/** "4:32" until then, ticking. */
function ResendCountdown({ to }: { to: number }) {
  const left = Math.max(0, Math.ceil((to - useNow(1000)) / 1000));
  return (
    <span className="font-mono tabular-nums">
      {Math.floor(left / 60)}:{String(left % 60).padStart(2, "0")}
    </span>
  );
}

/**
 * No Credit account yet: within five minutes of the upstream's answer the
 * viewer may open one and send the payment again, once (api:
 * payments/resend.ts, user's rule); past that it is not paid.
 */
function NoCreditAccount({
  activityId,
  claimId,
  payment,
  amount,
  onResent,
}: {
  activityId: string;
  claimId: string;
  payment: PaymentView;
  amount: string;
  onResent: () => void;
}) {
  const identity = useIdentity();
  const until = payment.resendUntil ? Date.parse(payment.resendUntil) : 0;
  const open = useBefore(until);
  const resend = useResendPayment(
    identity.user?.id ?? "",
    identity.csrfToken ?? "",
    activityId,
  );
  if (!open || !identity.user || !identity.csrfToken)
    return (
      <Callout
        icon={UserRoundX}
        title="这笔没能发出"
        className="w-full text-left"
      >
        LDC 里找不到你的 LINUX DO Credit 账户。被拒后 5
        分钟内可以重新发送一次，现在已经不能再发，这笔不再补发。
      </Callout>
    );
  const error = resend.error
    ? resend.error instanceof ActivityRequestError
      ? resend.error.message
      : "重新发送失败，请稍后再试。"
    : null;
  return (
    <Callout
      tone="warning"
      icon={UserRoundX}
      title="还没有 LINUX DO Credit 账户"
      className="w-full text-left"
    >
      <p>
        LDC 里找不到你的账户，这笔 {amount} LDC 暂时发不出去。请先注册 Credit
        账户，确认注册好了再回来点“重新发送”：只能重新发送一次。
      </p>
      <div className="mt-2.5 flex flex-wrap items-center gap-2">
        <ButtonLink href={CREDIT_URL} variant="secondary" className="gap-1.5">
          注册 Credit 账户
          <ArrowUpRight aria-hidden="true" />
        </ButtonLink>
        <Button
          variant="primary"
          size="sm"
          aria-disabled={resend.isPending || undefined}
          onClick={() => {
            if (resend.isPending) return;
            resend.mutate(claimId, { onSuccess: onResent });
          }}
        >
          {resend.isPending ? "正在重新发送…" : "重新发送"}
        </Button>
      </div>
      <p className="mt-2 text-xs">
        还剩 <ResendCountdown to={until} /> 可以重新发送，过时不再补发。
      </p>
      {error && (
        <p role="alert" className="mt-1 text-danger">
          {error}
        </p>
      )}
    </Callout>
  );
}

/** 报名 that is waiting or being drawn: the ticket's times and one rule. */
function TicketNote({
  mine,
  deadlineAt,
}: {
  mine: Extract<Mine, { kind: "registered" }>;
  deadlineAt: number;
}) {
  if (mine.outcome === "waiting")
    return (
      <p className="text-sm text-ink-2">
        {clockLabel(mine.at)} 报名，最晚 {clockLabel(deadlineAt)}{" "}
        开奖。再次报名不会增加中奖机会。
      </p>
    );
  if (mine.outcome === "settling")
    return (
      <p className="text-sm text-ink-2">
        正在抽取中奖名单并创建付款，结果出来后显示在这里。
      </p>
    );
  if (mine.outcome === "lost")
    return (
      <p className="text-sm text-ink-2">报名记录留在红包记录的“我参与的”里。</p>
    );
  return null;
}

/** The 口令 used: hidden behind an eye while the 红包 runs (05 §9). */
function PasswordChip({
  text,
  seed,
  ended,
}: {
  text: string;
  seed: string;
  ended: boolean;
}) {
  const [revealed, setRevealed] = useState(false);
  return (
    <span className="inline-flex max-w-full items-center gap-0.5">
      <Squircle radius={8}>
        {/* A long 口令 goes on to a second line, under itself. */}
        <span className="inline-flex min-h-7 min-w-0 items-baseline gap-1.5 bg-fill px-2.5 py-1 text-sm text-ink-2">
          <span className="shrink-0">口令</span>
          <PasswordText
            text={text}
            shown={ended || revealed}
            seed={seed}
            wrap
            className="min-w-0 text-ink"
          />
        </span>
      </Squircle>
      {!ended && (
        <RevealToggle
          shown={revealed}
          onToggle={() => setRevealed((value) => !value)}
        />
      )}
    </span>
  );
}

/**
 * 我的结果: what only the viewer sees after taking part — the amount in
 * green with a plus, the payment, the 口令 used, own titles, 奖励附言.
 */
/** What on this card only the viewer sees, as it is shown. */
function privateNote(mine: Mine, won: boolean) {
  const parts = won ? ["金额", "发放状态"] : ["报名记录"];
  if (mine.password) parts.push("口令");
  if (mine.afterClaimInfo) parts.push("附言");
  const last = parts.pop();
  return `${parts.length > 0 ? `${parts.join("、")}和` : ""}${last}仅你可见`;
}

export function MyResult({
  activity,
  mine,
  play,
  delay,
  deadlineAt,
  ended,
  ref,
}: {
  activity: HongbaoActivity;
  mine: Mine;
  /** Count up and stagger in (the opening, or a draw result arriving). */
  play: boolean;
  delay: number;
  deadlineAt: number;
  /** Over: the 口令 is public, shown plain. */
  ended: boolean;
  ref?: Ref<HTMLDivElement>;
}) {
  const won = mine.kind === "claimed" || mine.outcome === "won";
  const amount = won ? mine.amount : undefined;
  const payment = mine.payment;
  // Sent again from here: until it lands, the note says so.
  const [resent, setResent] = useState(false);
  return (
    <div
      ref={ref}
      tabIndex={-1}
      data-hb-part="result"
      className="mx-auto grid w-full max-w-[36rem] justify-items-center gap-3 px-5 pt-6 text-center outline-none"
    >
      {amount ? (
        <p className="flex items-baseline gap-2 text-success">
          <span className="text-[clamp(2.75rem,12cqw,4.5rem)] leading-none font-semibold tracking-tight">
            <CountUp value={amount} play={play} delay={delay} prefix="+" />
          </span>
          <span className="text-xl font-medium">LDC</span>
        </p>
      ) : (
        <p className="text-2xl font-semibold text-ink">
          {mine.kind === "registered" && mine.outcome === "lost"
            ? "本次未中奖"
            : mine.kind === "registered" && mine.outcome === "settling"
              ? "正在开奖…"
              : "已报名"}
        </p>
      )}

      <div className="flex flex-wrap items-center justify-center gap-2">
        {amount && payment ? (
          <PaymentStatus state={payment.status} />
        ) : mine.kind === "registered" && mine.outcome === "waiting" ? (
          <span className="text-sm text-ink-2">
            距开奖 <Countdown to={deadlineAt} />
          </span>
        ) : mine.kind === "registered" && mine.outcome === "lost" ? (
          <span className="text-sm text-ink-2">谢谢参与</span>
        ) : null}
        {mine.password && (
          <PasswordChip
            text={mine.password}
            seed={`${activity.id}:mine`}
            ended={ended}
          />
        )}
        {/* Titles share the row with the status and the 口令, arriving last. */}
        {mine.titles.length > 0 && (
          <motion.span
            className="inline-flex"
            initial={play ? { opacity: 0, scale: 0.92 } : false}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ duration: 0.2, delay: delay + 0.3 }}
          >
            <TitleBadges titles={mine.titles} size="md" />
          </motion.span>
        )}
      </div>

      {amount && payment ? (
        heldForAccount(payment) && mine.claimId ? (
          <NoCreditAccount
            activityId={activity.id}
            claimId={mine.claimId}
            payment={payment}
            amount={amount}
            onResent={() => setResent(true)}
          />
        ) : (
          <PaymentNote
            payment={payment}
            resending={resent && payment.status !== "confirmed"}
          />
        )
      ) : (
        mine.kind === "registered" && (
          <TicketNote mine={mine} deadlineAt={deadlineAt} />
        )
      )}

      {mine.afterClaimInfo && (
        <Squircle radius={16}>
          <div className="hb-note-card grid w-full gap-1.5 px-4 py-3 text-left">
            <p className="text-xs font-medium text-gold-ink">附言</p>
            <NoteMarkdown className="text-base">
              {mine.afterClaimInfo}
            </NoteMarkdown>
            <p className="flex items-center justify-end gap-1.5 text-xs text-ink-3">
              来自
              <Avatar
                name={activity.author.displayName}
                src={activity.author.avatarUrl}
                size={18}
              />
              <PersonName
                name={activity.author.displayName}
                username={activity.author.username}
                avatarUrl={activity.author.avatarUrl}
              />
            </p>
          </div>
        </Squircle>
      )}

      <p className="flex items-center gap-1.5 text-xs text-ink-3">
        <Lock className="size-3.5" aria-hidden="true" />
        {privateNote(mine, won)}
      </p>
    </div>
  );
}
