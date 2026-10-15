import {
  PAYMENT_LABELS,
  type PaymentState,
  type PaymentView,
} from "@hb/contracts";
import { Lock } from "lucide-react";
import { motion } from "motion/react";
import type { Ref } from "react";
import type { HongbaoActivity, Mine } from "../../lib/hongbao";
import { paymentTone } from "../../lib/hongbao-text";
import { clockLabel, clockSeconds } from "../../lib/roster-time";
import { Avatar } from "../ui/avatar";
import { NoteMarkdown } from "../ui/markdown";
import { PersonName } from "../ui/person";
import { Squircle } from "../ui/squircle";
import { StatusChip } from "../ui/status-chip";
import { Countdown } from "./cover-data";
import { CountUp } from "./parts";
import { TitleBadges } from "./title-badge";

function PaymentStatus({ state }: { state: PaymentState }) {
  return (
    <StatusChip size="md" tone={paymentTone(state)} dot>
      {PAYMENT_LABELS[state]}
    </StatusChip>
  );
}

// The claimant's side of a payment that is held up, when the server has no
// reason of its own to give.
const paymentReasons: Partial<Record<PaymentState, string>> = {
  reconciling: "付款结果尚未明确，正在核对原订单。",
  waiting: "商户资金不足，等待补足后恢复。",
  attention: "发送已暂停，等待发红包的人处理。",
};

/** Under the status: why it waits, or when it was confirmed. */
function PaymentNote({ payment }: { payment: PaymentView }) {
  const text =
    payment.status === "confirmed"
      ? payment.confirmedAt
        ? `${clockSeconds(Date.parse(payment.confirmedAt))} 确认到账`
        : null
      : (payment.reason ?? paymentReasons[payment.status]);
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
  ref,
}: {
  activity: HongbaoActivity;
  mine: Mine;
  /** Count up and stagger in (the opening, or a draw result arriving). */
  play: boolean;
  delay: number;
  deadlineAt: number;
  ref?: Ref<HTMLDivElement>;
}) {
  const won = mine.kind === "claimed" || mine.outcome === "won";
  const amount = won ? mine.amount : undefined;
  const payment = mine.payment;
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

      {amount
        ? payment && <PaymentNote payment={payment} />
        : mine.kind === "registered" && (
            <TicketNote mine={mine} deadlineAt={deadlineAt} />
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
