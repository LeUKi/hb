import {
  type ActivityPoints,
  PAYMENT_LABELS,
  type PaymentState,
  type PaymentView,
} from "@hb/contracts";
import { useNavigate } from "@tanstack/react-router";
import { ArrowUpRight, Lock, UserRoundX, X } from "lucide-react";
import { motion } from "motion/react";
import {
  type ReactNode,
  type Ref,
  useContext,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { ActivityRequestError } from "../../lib/activities";
import { useResendPayment } from "../../lib/claims";
import { SiteLinkContext, useEmbedded } from "../../lib/embedded";
import type { HongbaoActivity, Mine } from "../../lib/hongbao";
import { paymentTone } from "../../lib/hongbao-text";
import { paymentReason, quotaResumeWords } from "../../lib/payment-display";
import { pointsFailureWords, usePointsDetail } from "../../lib/points";
import { clockLabel, clockSeconds } from "../../lib/roster-time";
import { useIdentity } from "../../lib/session";
import { amountText } from "../../lib/units";
import { useBefore } from "../../lib/use-before";
import { Callout } from "../page/page";
import { Bone } from "../page/page-state";
import { ConfirmDialog } from "../shell/confirm-dialog";
import { WindowDialog } from "../shell/window-dialog";
import { Avatar } from "../ui/avatar";
import { Button } from "../ui/button";
import { ButtonLink, MoreLink } from "../ui/button-link";
import { FishMark } from "../ui/fish";
import { NoteMarkdown } from "../ui/markdown";
import { MorphLabel } from "../ui/morph-label";
import { PersonName } from "../ui/person";
import { Reveal } from "../ui/reveal";
import { Squircle } from "../ui/squircle";
import { StatusChip } from "../ui/status-chip";
import { useNow } from "./clock";
import { Countdown } from "./cover-data";
import { CountUp } from "./parts";
import { TitleBadges } from "./title-badge";

/** A 🐟额红包's share: in 🐟额 already, and the way on to Credit. */
function FishStored() {
  const navigate = useNavigate();
  // In the forum's mini app: 转出 is on 红包站.
  const embedded = useEmbedded();
  return (
    <span className="inline-flex items-center gap-1">
      <StatusChip size="md" tone="success" dot>
        已存入🐟额
      </StatusChip>
      {!embedded && (
        <MoreLink
          href="/balance"
          onGo={() => void navigate({ to: "/balance" })}
        >
          转出
        </MoreLink>
      )}
    </span>
  );
}

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
  attention: "发送已暂停，等待红包作者处理。",
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
          ? `红包作者今天在 Credit 站的发放额度用完了，${quotaResumeWords(payment.quotaResumeAt)}自动继续发放。`
          : (paymentReason(payment.reason, null) ??
            paymentReasons[payment.status]);
  return text ? <p className="text-sm text-ink-2">{text}</p> : null;
}

/** Where a LINUX DO Credit account is opened. */
const CREDIT_URL = "https://credit.linux.do";

/**
 * 收款人不存在: the upstream knows no Credit account for the viewer. Past
 * its resend it ends 未发出 (failed), and says so the same way.
 */
const heldForAccount = (payment: PaymentView) =>
  (payment.status === "attention" || payment.status === "failed") &&
  payment.reason === "recipient";

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
 * 重新发送 asks first (the user, 2026-11-11): a payment is sent again only
 * once, so the person says their account is ready before it goes. One
 * wording for every 三方积分, which issuers do not write, and the same shape
 * for Credit.
 */
function ResendButton({
  account,
  amount,
  pending,
  onConfirm,
}: {
  /** "已经在 x.com 开好账户", "已经注册好 LINUX DO Credit 账户". */
  account: string;
  /** "12.50 LDC", "300 星星". */
  amount: string;
  pending: boolean;
  onConfirm: () => void;
}) {
  const [asking, setAsking] = useState(false);
  return (
    <>
      <Button
        variant="primary"
        size="sm"
        aria-disabled={pending || undefined}
        onClick={() => {
          if (!pending) setAsking(true);
        }}
      >
        {pending ? "正在重新发送…" : "重新发送"}
      </Button>
      <ConfirmDialog
        open={asking}
        onClose={() => setAsking(false)}
        title="确定重新发送？"
        text={`只能重新发送一次。请先确认你${account}；如果还是找不到你的账户，这笔 ${amount} 就不再补发。`}
        actions={
          <>
            <Button onClick={() => setAsking(false)}>再等等</Button>
            <Button
              variant="primary"
              onClick={() => {
                setAsking(false);
                onConfirm();
              }}
            >
              重新发送
            </Button>
          </>
        }
      />
    </>
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
  if (!open || !identity.user || !identity.csrfToken) return <NotResent />;
  const error = resend.error
    ? resend.error instanceof ActivityRequestError
      ? resend.error.message
      : "重新发送没有完成，请稍后再试。"
    : null;
  return (
    <Callout
      tone="warning"
      icon={UserRoundX}
      title="还没有 LINUX DO Credit 账户"
      className="w-full text-left"
    >
      <p>
        Credit 站里找不到你的账户，这笔 {amount} LDC 暂时发不出去。请先注册
        Credit 账户，确认注册好了再回来点“重新发送”：只能重新发送一次。
      </p>
      <div className="mt-2.5 flex flex-wrap items-center gap-2">
        <ButtonLink href={CREDIT_URL} variant="secondary" className="gap-1.5">
          注册 Credit 账户
          <ArrowUpRight aria-hidden="true" />
        </ButtonLink>
        <ResendButton
          account="已经注册好 LINUX DO Credit 账户"
          amount={`${amount} LDC`}
          pending={resend.isPending}
          onConfirm={() => resend.mutate(claimId, { onSuccess: onResent })}
        />
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

/** Past its one 重新发送: it is not paid. */
function NotResent() {
  return (
    <Callout
      icon={UserRoundX}
      title="这笔没能发出"
      className="w-full text-left"
    >
      Credit 站里找不到你的 LINUX DO Credit 账户。被拒后 5
      分钟内可以重新发送一次，现在已经不能再发，这笔不再补发。
    </Callout>
  );
}

/**
 * The same in the 社区's mini app: 重新发送 is on 红包站 alone (the user's
 * rule), so it says how to get there in time and copies this 红包's link
 * there (SiteLinkContext).
 */
function NoCreditAccountHere({
  payment,
  amount,
}: {
  payment: PaymentView;
  amount: string;
}) {
  const until = payment.resendUntil ? Date.parse(payment.resendUntil) : 0;
  const open = useBefore(until);
  const SiteLink = useContext(SiteLinkContext);
  if (!open || !SiteLink) return <NotResent />;
  return (
    <Callout
      tone="warning"
      icon={UserRoundX}
      title="还没有 LINUX DO Credit 账户"
      className="w-full text-left"
    >
      <p>
        这笔 {amount} LDC 发不出去。先在 credit.linux.do
        注册，再到红包站打开这个红包，登录后点“重新发送”，只能发一次。
      </p>
      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-2">
        <SiteLink />
        <span className="text-xs">
          还剩 <ResendCountdown to={until} />
          ，过时不再补发
        </span>
      </div>
    </Callout>
  );
}

/**
 * 三方积分 (docs/third-party-points-design.md §9): no account at the
 * issuer. The issuer's own words, the five minutes, and one 重新发送.
 */
function NoPointsAccount({
  activityId,
  claimId,
  payment,
  amount,
  points,
  onResent,
}: {
  activityId: string;
  claimId: string;
  payment: PaymentView;
  amount: string;
  points: ActivityPoints;
  onResent: () => void;
}) {
  const identity = useIdentity();
  const detail = usePointsDetail(points.id);
  const until = payment.resendUntil ? Date.parse(payment.resendUntil) : 0;
  const open = useBefore(until);
  const resend = useResendPayment(
    identity.user?.id ?? "",
    identity.csrfToken ?? "",
    activityId,
  );
  const words = detail.data?.system.noRecipient;
  const unit = { unit: points.unit, step: points.step };
  if (!open || !identity.user || !identity.csrfToken)
    return (
      <Callout
        icon={UserRoundX}
        title="这笔没能发出"
        className="w-full text-left"
      >
        {points.host} 找不到你的账户。被拒后 5
        分钟内可以重新发送一次，现在已经不能再发，这笔不再补发。
      </Callout>
    );
  const error = resend.error
    ? resend.error instanceof ActivityRequestError
      ? resend.error.message
      : "重新发送没有完成，请稍后再试。"
    : null;
  return (
    <Callout
      tone="warning"
      icon={UserRoundX}
      title={`你在 ${points.host} 还没有账户`}
      className="w-full text-left"
    >
      <p>
        这笔 {amountText(amount, unit)}{" "}
        暂时发不出去。先在那边开好账户，再回来点“重新发送”：只能重新发送一次。
      </p>
      {/* The issuer's words are read on their own: a bar while they are,
          then they open in (none written: nothing). */}
      <IssuerWords pending={detail.isPending} className="mt-2">
        {words ? (
          <NoteMarkdown className="text-sm">{words}</NoteMarkdown>
        ) : null}
      </IssuerWords>
      <div className="mt-2.5 flex flex-wrap items-center gap-2">
        <ResendButton
          account={`已经在 ${points.host} 开好账户`}
          amount={amountText(amount, unit)}
          pending={resend.isPending}
          onConfirm={() => resend.mutate(claimId, { onSuccess: onResent })}
        />
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

/** A 三方积分 payout's line under its status (§9): where it went, or why not. */
function PointsPaymentNote({
  payment,
  points,
  resending,
}: {
  payment: PaymentView;
  points: ActivityPoints;
  resending: boolean;
}) {
  const detail = usePointsDetail(points.id);
  const system = { ...points, notAllowed: detail.data?.system.notAllowed };
  if (payment.status === "confirmed")
    return (
      <div className="grid gap-0.5 text-sm text-ink-2">
        <p>
          已存进你在 {points.host} 的账户
          {payment.confirmedAt
            ? `（${clockSeconds(Date.parse(payment.confirmedAt))}）`
            : ""}
          。
        </p>
        <IssuerWords pending={detail.isPending}>
          {detail.data?.system.arrival ? (
            <p>{detail.data.system.arrival}</p>
          ) : null}
        </IssuerWords>
      </div>
    );
  // 不允许 says the issuer's own sentence: a bar until it is read, never
  // the default first and then another.
  if (
    payment.status === "failed" &&
    payment.reason === "not_allowed" &&
    !resending &&
    detail.isPending
  )
    return <IssuerWords pending>{null}</IssuerWords>;
  const text = resending
    ? "正在重新发送，稍等十几秒。"
    : payment.status === "failed"
      ? pointsFailureWords(payment.reason, system)
      : payment.status === "attention"
        ? pointsFailureWords("unknown", system)
        : payment.status === "reconciling"
          ? `${points.host} 刚才没有回复，稍后会再试。`
          : `正在发到你在 ${points.host} 的账户。`;
  return text ? <p className="text-sm text-ink-2">{text}</p> : null;
}

/**
 * Words an issuer wrote, read apart from the 红包: a sheen bar in their
 * place while they are read, then they open in (redesign-ui-feedback: no
 * text that arrives late or swaps).
 */
function IssuerWords({
  pending,
  className,
  children,
}: {
  pending: boolean;
  className?: string;
  children: ReactNode;
}) {
  if (pending)
    return (
      <div className={className} aria-hidden="true">
        <Bone className="h-3.5 w-3/4" />
      </div>
    );
  return (
    <Reveal show={children !== null} className={className}>
      {children}
    </Reveal>
  );
}

/** 报名 that is waiting or being drawn: the ticket's times and one rule. */
function TicketNote({
  mine,
  deadlineAt,
  drawNote,
}: {
  mine: Extract<Mine, { kind: "registered" }>;
  deadlineAt: number;
  /** A v2 draw's step while it is drawn (useDrawStep). */
  drawNote?: string;
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
        <MorphLabel fit={false}>
          {drawNote ?? "正在抽取中奖名单并创建付款，结果出来后显示在这里。"}
        </MorphLabel>
      </p>
    );
  if (mine.outcome === "lost")
    return (
      <p className="text-sm text-ink-2">报名记录留在红包记录的“我参与的”里。</p>
    );
  return null;
}

/** 代码判定: why a share is not what the code asked (05 §13). */
const judgeNotes = {
  cap: "按上限发",
  floor: "按每份至少发",
  last: "最后一份，发完剩下的",
} as const;

/**
 * 奖励附言 in its card. In the 社区's mini app, three lines at most and the
 * rest in a dialog (展开全文); folded, while a card says the payment did not
 * go out, only a button to that dialog. A post's frame is only as tall as
 * the 红包's tallest page (docs/mini-app-design.md §4), and a 附言 runs to
 * 10,000 字.
 */
function AfterClaimNote({
  text,
  folded = false,
}: {
  text: string;
  folded?: boolean;
}) {
  const embedded = useEmbedded();
  const ref = useRef<HTMLDivElement>(null);
  const [cut, setCut] = useState(false);
  const [open, setOpen] = useState(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: measure again when the 附言 changes.
  useLayoutEffect(() => {
    const element = ref.current;
    if (!embedded || !element) return;
    const measure = () =>
      setCut(element.scrollHeight > element.clientHeight + 1);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [embedded, text]);
  if (!embedded)
    return <NoteMarkdown className="text-base">{text}</NoteMarkdown>;
  const more = (label: string) => (
    <button
      type="button"
      aria-haspopup="dialog"
      onClick={() => setOpen(true)}
      className="justify-self-end text-sm text-gold-ink underline decoration-1.5 underline-offset-4"
    >
      {label}
    </button>
  );
  return (
    <>
      {folded ? (
        more("看红包作者的附言")
      ) : (
        <>
          <div
            ref={ref}
            data-cut={cut || undefined}
            className="hb-after-note grid max-h-[4.5rem] overflow-hidden"
          >
            <NoteMarkdown className="text-base">{text}</NoteMarkdown>
          </div>
          {cut && more("展开全文")}
        </>
      )}
      <WindowDialog
        open={open}
        onClose={() => setOpen(false)}
        labelledBy="after-note-title"
        width="34rem"
      >
        <header className="flex items-center justify-between gap-3 px-5 pt-4 pb-3">
          <h2 id="after-note-title" className="text-lg font-semibold text-ink">
            附言
          </h2>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="关闭"
            className="-mr-2 shrink-0"
            onClick={() => setOpen(false)}
          >
            <X />
          </Button>
        </header>
        <div className="view-scroll relative min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 pb-5">
          <NoteMarkdown className="text-base">{text}</NoteMarkdown>
        </div>
      </WindowDialog>
    </>
  );
}

/**
 * 我的结果: what only the viewer sees after taking part — the amount in
 * green with a plus, the payment, own titles, 奖励附言.
 */
/**
 * What on this card only the viewer sees, as it is shown: not the
 * 判定器's reply, which its sender reads in 判定记录 too.
 */
function privateNote(mine: Mine, won: boolean) {
  const parts = won ? ["金额", "发放状态"] : ["报名记录"];
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
  drawNote,
  ref,
}: {
  activity: HongbaoActivity;
  mine: Mine;
  /** A v2 draw's step while it is drawn (useDrawStep). */
  drawNote?: string;
  /** Count up and stagger in (the opening, or a draw result arriving). */
  play: boolean;
  delay: number;
  deadlineAt: number;
  ref?: Ref<HTMLDivElement>;
}) {
  const won = mine.kind === "claimed" || mine.outcome === "won";
  const amount = won ? mine.amount : undefined;
  const payment = mine.payment;
  // Sent again from here: until it lands, the note says so.
  const [resent, setResent] = useState(false);
  const embedded = useEmbedded();
  return (
    <div
      ref={ref}
      tabIndex={-1}
      data-hb-part="result"
      className="mx-auto grid w-full max-w-[36rem] justify-items-center gap-3 px-5 pt-6 text-center outline-none"
    >
      {amount ? (
        <p className="flex items-baseline gap-2 text-success">
          <span className="hb-result-amount text-[clamp(2.75rem,12cqw,4.5rem)] leading-none font-semibold tracking-tight">
            <CountUp
              value={amount}
              play={play}
              delay={delay}
              prefix="+"
              step={activity.unit.step}
            />
          </span>
          <span className="text-xl font-medium">
            {activity.unit.unit}
            {activity.fish && <FishMark explained />}
          </span>
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

      {/* 代码判定: the code's reply under the amount, and why the amount
          is not what the code asked (05 §13). */}
      {mine.kind === "claimed" && mine.judge && (
        <div className="grid gap-1">
          {mine.judge.message && (
            <p className="text-base text-ink">
              <span className="text-ink-3">判定器的回复：</span>
              {mine.judge.message}
            </p>
          )}
          {mine.judge.note && (
            <p className="text-sm text-ink-2">{judgeNotes[mine.judge.note]}</p>
          )}
        </div>
      )}

      <div className="flex flex-wrap items-center justify-center gap-2">
        {amount && activity.fish ? (
          <FishStored />
        ) : amount && mine.self ? (
          <StatusChip size="md" dot>
            自领
          </StatusChip>
        ) : amount && payment ? (
          <PaymentStatus state={payment.status} />
        ) : mine.kind === "registered" && mine.outcome === "waiting" ? (
          <span className="text-sm text-ink-2">
            距开奖 <Countdown to={deadlineAt} />
          </span>
        ) : mine.kind === "registered" && mine.outcome === "lost" ? (
          <span className="text-sm text-ink-2">谢谢参与</span>
        ) : null}
        {/* Titles share the row with the status, arriving last. The 口令
            used is in the 口令区, what was typed in 我的提交: not again here. */}
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

      {/* 自领: where the share is, said to the sender alone
          (docs/self-claim-design.md). */}
      {amount && mine.self ? (
        <p className="text-sm text-ink-2">
          {activity.fish
            ? "这份已退回你的🐟额。"
            : activity.points
              ? `这份没有发出去，还在你在 ${activity.points.host} 的账户里。`
              : "这份没有发出去，钱还在付款的商户账户里。"}
        </p>
      ) : /* A 🐟额红包's share is in 🐟额 already: nothing to follow (under
          1 🐟 it goes to Credit all at once, balance-design §5). */
      amount && activity.fish ? null : amount && payment && activity.points ? (
        // Still no account: the one 重新发送 while it lasts, then (also once
        // it ended 未发出) why it was not paid.
        (payment.status === "attention" || payment.status === "failed") &&
        payment.reason === "recipient" &&
        mine.claimId ? (
          <NoPointsAccount
            activityId={activity.id}
            claimId={mine.claimId}
            payment={payment}
            amount={amount}
            points={activity.points}
            onResent={() => setResent(true)}
          />
        ) : (
          <PointsPaymentNote
            payment={payment}
            points={activity.points}
            resending={resent && payment.status !== "confirmed"}
          />
        )
      ) : amount && payment ? (
        // 重新发送 needs this site's session: the mini app leads here.
        heldForAccount(payment) && embedded ? (
          <NoCreditAccountHere payment={payment} amount={amount} />
        ) : heldForAccount(payment) && mine.claimId ? (
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
          <TicketNote mine={mine} deadlineAt={deadlineAt} drawNote={drawNote} />
        )
      )}

      {mine.afterClaimInfo && embedded && payment && heldForAccount(payment) ? (
        <AfterClaimNote text={mine.afterClaimInfo} folded />
      ) : mine.afterClaimInfo ? (
        <Squircle radius={16}>
          <div className="hb-note-card grid w-full gap-1.5 px-4 py-3 text-left">
            <p className="text-xs font-medium text-gold-ink">附言</p>
            <AfterClaimNote text={mine.afterClaimInfo} />
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
      ) : null}

      <p className="flex items-center gap-1.5 text-xs text-ink-3">
        <Lock className="size-3.5" aria-hidden="true" />
        {privateNote(mine, won)}
      </p>
    </div>
  );
}
