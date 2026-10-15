import { PAYMENT_LABELS, type PaymentState } from "@hb/contracts";
import type { RosterRow } from "../../lib/hongbao";
import { paymentTone } from "../../lib/hongbao-text";
import { fullTime, sinceOpen } from "../../lib/roster-time";
import { type LazyList, LazyListEnd } from "../page/lazy-list";
import { Avatar } from "../ui/avatar";
import { PersonName } from "../ui/person";
import { Squircle } from "../ui/squircle";
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
  onPayment,
}: {
  row: RosterRow;
  kind: RosterKind;
  openedAt: number;
  detail?: RowDetail | null;
  onPayment?: (id: string) => void;
}) {
  return (
    <li>
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
                  <span className="min-w-0 truncate">
                    口令 <span className="font-mono">{detail.password}</span>
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
    </li>
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
        {rows.map((row) => (
          <Row
            key={row.id}
            row={row}
            kind={kind}
            openedAt={openedAt}
            detail={detailOf?.(row)}
            onPayment={onPayment}
          />
        ))}
      </ol>
      <LazyListEnd
        list={list}
        done={done}
        className="min-h-0 px-6 pt-1 pb-4 text-xs"
      />
    </>
  );
}
