import { PAYMENT_LABELS, type PaymentState } from "@hb/contracts";
import { RotateCw } from "lucide-react";
import { AnimatePresence } from "motion/react";
import type { RosterRow } from "../../lib/hongbao";
import { paymentTone } from "../../lib/hongbao-text";
import { fullTime, sinceOpen } from "../../lib/roster-time";
import { type LazyList, LazyListEnd } from "../page/lazy-list";
import { Bone } from "../page/page-state";
import { Avatar } from "../ui/avatar";
import { Button } from "../ui/button";
import { PersonName } from "../ui/person";
import { ListItem } from "../ui/reveal";
import { Squircle } from "../ui/squircle";
import { PasswordText } from "./password-text";
import { TitleBadges } from "./title-badge";

const paymentText = {
  success: "text-success",
  warning: "text-warning",
  danger: "text-danger",
} as const;

/** Which list: claims (用时 + amount), sign-ups (用时), winners (amount). */
export type RosterKind = "claims" | "registrations" | "winners";

// Narrow windows trade column width for the name, so a long title badge
// ("我焯有桂！") still leaves room for a few characters of it.
const columns: Record<RosterKind, string> = {
  claims:
    "grid-cols-[1.25rem_1.375rem_minmax(3em,1fr)_4.25rem_3rem] @wide/window:grid-cols-[1.75rem_1.375rem_minmax(3em,1fr)_5.25rem_3.5rem]",
  registrations:
    "grid-cols-[1.25rem_1.375rem_minmax(3em,1fr)_4.25rem] @wide/window:grid-cols-[1.75rem_1.375rem_minmax(3em,1fr)_5.25rem]",
  winners:
    "grid-cols-[1.25rem_1.375rem_minmax(3em,1fr)_3rem] @wide/window:grid-cols-[1.75rem_1.375rem_minmax(3em,1fr)_3.5rem]",
};

const who: Record<RosterKind, string> = {
  claims: "领取人",
  registrations: "报名人",
  winners: "中奖人",
};

/** The column labels, kept apart from the rows so the list can scroll. */
export function RosterHeader({ kind }: { kind: RosterKind }) {
  return (
    <div
      aria-hidden="true"
      className={`grid h-8 items-center gap-x-2 border-b border-line px-6 text-xs text-ink-3 @wide/window:gap-x-2.5 ${columns[kind]}`}
    >
      <span className="text-right">#</span>
      <span />
      <span>{who[kind]}</span>
      {kind !== "winners" && <span className="text-right">用时</span>}
      {kind !== "registrations" && <span className="text-right">LDC</span>}
    </div>
  );
}

/** What only the sender sees on a row: the 口令 used and the payment. */
export type RowDetail = {
  password: string | null;
  payment: { id: string; state: PaymentState } | null;
};

/** One person, one line: rank, avatar, name, titles, 用时, amount. */
function Row({
  row,
  kind,
  openedAt,
  detail,
  passwordsShown,
  onPayment,
}: {
  row: RosterRow;
  kind: RosterKind;
  openedAt: number;
  detail?: RowDetail | null;
  passwordsShown: boolean;
  onPayment?: (id: string) => void;
}) {
  return (
    <ListItem>
      <Squircle radius={10}>
        <div
          title={fullTime(row.at)}
          className={`grid items-center gap-x-2 px-4 @wide/window:gap-x-2.5 ${columns[kind]} ${
            detail ? "py-1.5" : "h-10"
          } ${row.you ? "bg-gold-soft" : ""}`}
        >
          {/* The column heads are hidden from screen readers (the list
              scrolls apart from them): each cell names itself. */}
          <span className="text-right font-mono text-xs text-ink-3 tabular-nums">
            <span className="sr-only">第</span>
            {row.rank}
            <span className="sr-only">位</span>
          </span>
          <Avatar name={row.name} src={row.avatarUrl} size={22} />
          <span className="grid min-w-0 gap-0.5">
            <span className="flex min-w-0 items-center gap-1.5">
              <PersonName
                name={row.name}
                username={row.username}
                avatarUrl={row.avatarUrl}
                className="min-w-[2.5em] text-sm text-ink"
              />
              {row.you && (
                <Squircle radius={7}>
                  <span className="chip chip-gold h-5 shrink-0 px-1.5 text-xs">
                    你
                  </span>
                </Squircle>
              )}
              <TitleBadges titles={row.titles} className="shrink-0" />
            </span>
            {detail && (
              <span className="flex min-w-0 items-center gap-2 text-xs text-ink-3">
                {detail.password && (
                  <span className="flex min-w-0 items-center gap-1">
                    <span className="shrink-0">口令</span>
                    <PasswordText
                      text={detail.password}
                      shown={passwordsShown}
                      seed={row.id}
                      className="min-w-0"
                    />
                  </span>
                )}
                {detail.payment && (
                  <button
                    type="button"
                    onClick={() => onPayment?.(detail.payment?.id ?? "")}
                    className={`inline-flex shrink-0 items-center gap-1 underline-offset-2 hover:underline ${paymentText[paymentTone(detail.payment.state)]}`}
                  >
                    <span
                      aria-hidden="true"
                      className="size-1.5 rounded-full bg-current"
                    />
                    {PAYMENT_LABELS[detail.payment.state]}
                  </button>
                )}
              </span>
            )}
          </span>
          {kind !== "winners" && (
            <span className="text-right font-mono text-xs text-ink-2 tabular-nums @wide/window:text-sm">
              <span className="sr-only">用时</span>
              {sinceOpen(row.at - openedAt)}
            </span>
          )}
          {kind !== "registrations" && (
            <span className="text-right font-mono text-sm font-medium text-ink tabular-nums">
              {row.amount}
              <span className="sr-only"> LDC</span>
            </span>
          )}
        </div>
      </Squircle>
    </ListItem>
  );
}

/** The rows read so far: nearing the end of the list reads the next 20. */
export function RosterList({
  rows,
  list,
  kind,
  openedAt,
  done,
  detailOf,
  passwordsShown = true,
  onPayment,
}: {
  rows: RosterRow[];
  list: LazyList;
  kind: RosterKind;
  openedAt: number;
  /** What the end says once everything is in. */
  done: string;
  /** The sender's extra line per row (only for the 红包's sender). */
  detailOf?: (row: RosterRow) => RowDetail | null;
  /** The 口令 on those lines: hidden while the 红包 runs, until asked. */
  passwordsShown?: boolean;
  onPayment?: (id: string) => void;
}) {
  if (rows.length === 0 && list.state === "done")
    return (
      <p className="px-6 py-8 text-center text-sm text-ink-3">
        {kind === "claims"
          ? "还没有人领取。"
          : kind === "winners"
            ? "没有人中奖。"
            : "还没有人报名。"}
      </p>
    );
  return (
    <>
      <ol
        className="grid px-2 py-1"
        aria-busy={list.state === "loading" || undefined}
      >
        <AnimatePresence initial={false}>
          {rows.map((row) => (
            <Row
              key={row.id}
              row={row}
              kind={kind}
              openedAt={openedAt}
              detail={detailOf?.(row)}
              passwordsShown={passwordsShown}
              onPayment={onPayment}
            />
          ))}
        </AnimatePresence>
      </ol>
      <LazyListEnd
        list={list}
        done={done}
        className="min-h-0 px-6 pt-1 pb-4 text-xs"
      />
    </>
  );
}

/** Grey rows where the roster goes, before its first batch is in. */
export function RosterSkeleton() {
  return (
    <div className="grid px-2 py-1">
      <p role="status" className="sr-only">
        正在读取…
      </p>
      <div aria-hidden="true" className="grid">
        {[0, 1, 2, 3, 4].map((row) => (
          <div key={row} className="flex h-10 items-center gap-2.5 px-4">
            <Bone className="h-3 w-4" />
            <Bone className="size-6 shrink-0" radius={12} />
            <Bone className={row % 2 ? "h-3 w-20" : "h-3 w-28"} />
            <span className="flex-1" />
            <Bone className="h-3 w-12" />
          </div>
        ))}
      </div>
    </div>
  );
}

/** The roster's first batch could not be read: say so, with 重试. */
export function RosterRetry({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="grid justify-items-center gap-2 px-6 py-8 text-center text-sm text-ink-3">
      <p role="alert">名单读取失败。</p>
      <Button size="sm" variant="ghost" onClick={onRetry}>
        <RotateCw aria-hidden="true" />
        重试
      </Button>
    </div>
  );
}
