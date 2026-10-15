import { PAYMENT_LABELS, type PaymentState } from "@hb/contracts";
import { useAtomValue } from "jotai";
import { Lock } from "lucide-react";
import { motion } from "motion/react";
import type { Ref } from "react";
import type { FixtureActivity } from "../../fixtures/activities";
import { type Mine, paymentOf } from "../../fixtures/hongbao";
import { clockLabel, clockSeconds } from "../../lib/roster-time";
import { paymentSimAtom } from "../../lib/store";
import { Avatar } from "../ui/avatar";
import { PersonName } from "../ui/person";
import { Squircle } from "../ui/squircle";
import { Countdown } from "./cover-data";
import { CountUp } from "./parts";
import { TitleBadges } from "./title-badge";
import { useNow } from "./use-hongbao";

const paymentTone = {
  pending: "text-warning bg-warning-soft",
  sending: "text-warning bg-warning-soft",
  reconciling: "text-warning bg-warning-soft",
  waiting: "text-warning bg-warning-soft",
  confirmed: "text-success bg-success-soft",
  attention: "text-danger bg-danger-soft",
} as const;

/** 发放状态 of the viewer's own claim; follows the payment as it moves. */
function usePaymentState(at: number) {
  const sim = useAtomValue(paymentSimAtom);
  const now = useNow(1000);
  return paymentOf(at, sim, now);
}

function PaymentStatus({ state }: { state: PaymentState }) {
  return (
    <Squircle radius={8}>
      <span
        className={`inline-flex h-7 items-center gap-1.5 px-2.5 text-sm font-medium ${paymentTone[state]}`}
      >
        <span className="size-1.5 rounded-full bg-current" />
        {PAYMENT_LABELS[state]}
      </span>
    </Squircle>
  );
}

// The claimant's side of a payment that is held up: the reason, in
// production's words (paymentReason); the prototype shows one per state.
const paymentReasons: Partial<Record<PaymentState, string>> = {
  reconciling: "付款结果尚未明确，正在核对原订单。",
  waiting: "商户资金不足，等待补足后恢复。",
  attention: "上游未找到指定收款人，发送已暂停。",
};

/** Under the status: why it waits, or when it was confirmed. */
function PaymentNote({ state, at }: { state: PaymentState; at: number }) {
  const text =
    state === "confirmed"
      ? // The prototype's payment confirms 9 s after the claim.
        `${clockSeconds(at + 9000)} 确认到账`
      : paymentReasons[state];
  return text ? <p className="text-sm text-ink-2">{text}</p> : null;
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

function PasswordChip({ text }: { text: string }) {
  return (
    <Squircle radius={8}>
      <span className="inline-flex h-7 items-center gap-1.5 bg-fill px-2.5 text-sm text-ink-2">
        口令 <span className="font-mono text-ink">{text}</span>
      </span>
    </Squircle>
  );
}

/**
 * 我的结果: what only the viewer sees after taking part — the amount in
 * green with a plus, the payment, the 口令 used, own titles, 奖励附言.
 */
export function MyResult({
  activity,
  mine,
  play,
  delay,
  deadlineAt,
  paidFrom,
  ref,
}: {
  activity: FixtureActivity;
  mine: Mine;
  /** Count up and stagger in (the opening, or a draw result arriving). */
  play: boolean;
  delay: number;
  deadlineAt: number;
  /** When the payment started: the claim, or the draw. */
  paidFrom: number;
  ref?: Ref<HTMLDivElement>;
}) {
  const won = mine.kind === "claimed" || mine.outcome === "won";
  const amount = won ? mine.amount : undefined;
  const payment = usePaymentState(paidFrom);
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
        {amount ? (
          <PaymentStatus state={payment} />
        ) : mine.kind === "registered" && mine.outcome === "waiting" ? (
          <span className="text-sm text-ink-2">
            距开奖 <Countdown to={deadlineAt} />
          </span>
        ) : mine.kind === "registered" && mine.outcome === "lost" ? (
          <span className="text-sm text-ink-2">谢谢参与</span>
        ) : null}
        {mine.password && <PasswordChip text={mine.password} />}
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

      {amount ? (
        <PaymentNote state={payment} at={paidFrom} />
      ) : (
        mine.kind === "registered" && (
          <TicketNote mine={mine} deadlineAt={deadlineAt} />
        )
      )}

      {mine.afterClaimInfo && (
        <Squircle radius={16}>
          <div className="hb-note-card grid w-full gap-1.5 px-4 py-3 text-left">
            <p className="text-xs font-medium text-gold-ink">奖励附言</p>
            <p className="text-base text-ink">{mine.afterClaimInfo}</p>
            <p className="flex items-center justify-end gap-1.5 text-xs text-ink-3">
              来自
              <Avatar name={activity.author.displayName} size={18} />
              <PersonName
                name={activity.author.displayName}
                username={activity.author.username}
              />
            </p>
          </div>
        </Squircle>
      )}

      <p className="flex items-center gap-1.5 text-xs text-ink-3">
        <Lock className="size-3.5" aria-hidden="true" />
        {won
          ? "金额、发放状态、口令和奖励附言仅你可见"
          : "报名记录和口令仅你可见"}
      </p>
    </div>
  );
}
