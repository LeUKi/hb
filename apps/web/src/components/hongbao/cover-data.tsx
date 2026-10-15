import { ChevronRight } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { cn } from "../../lib/cn";
import type { HongbaoActivity, PublicView, Roster } from "../../lib/hongbao";
import { Avatar } from "../ui/avatar";
import { Squircle } from "../ui/squircle";
import { type CoverCell, coverCells } from "./cover-cells";
import type { CoverMotion } from "./cover-motion";
import { countdown, useNow } from "./use-hongbao";

/** Ticks on its own, so the page around it does not re-render every second. */
export function Countdown({ to }: { to: number }) {
  const now = useNow(1000);
  return <span className="font-mono tabular-nums">{countdown(to - now)}</span>;
}

/** The bar the owner likes: cream track, gold fill, on the red. */
function Meter({ share, label }: { share: number; label: string }) {
  return (
    <Squircle radius={3}>
      <span
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(share * 100)}
        className="hb-data-meter block h-1.5 w-full overflow-hidden"
      >
        <span
          className="block h-full"
          style={{ width: `${Math.min(1, share) * 100}%` }}
        />
      </span>
    </Squircle>
  );
}

/** Four steps for a fuzzy level; no numbers. */
function Steps({ filled }: { filled: number }) {
  return (
    <span aria-hidden="true" className="flex w-full gap-1">
      {[0, 1, 2, 3].map((step) => (
        <Squircle key={step} radius={2}>
          <span
            className={`hb-data-step h-1.5 flex-1 ${step < filled ? "hb-data-step-on" : ""}`}
          />
        </Squircle>
      ))}
    </span>
  );
}

/**
 * A cell from coverCells(). Big: label, value, and a third row (a note, the
 * bar or the four steps). Small: label and value on one line, the third row
 * shrunk away. Label and value are the same elements in both, so they move
 * and scale instead of swapping.
 */
function DataCell({
  cell,
  motions,
}: {
  cell: CoverCell;
  motions: CoverMotion;
}) {
  const small = motions.state === "small";
  return (
    <div
      className={cn(
        "relative min-w-0",
        small
          ? "flex items-baseline gap-1.5"
          : "grid content-start justify-items-start gap-1",
      )}
    >
      <motion.dt
        {...motions.leaf}
        className="hb-data-label w-fit max-w-full truncate"
      >
        {cell.label}
      </motion.dt>
      <motion.dd
        {...motions.leaf}
        className="hb-data-value w-fit max-w-full truncate"
      >
        {cell.until !== undefined ? <Countdown to={cell.until} /> : cell.value}
      </motion.dd>
      <AnimatePresence mode="popLayout" initial={false}>
        {!small && (
          <motion.dd
            key="third"
            className="hb-data-note flex w-full items-center truncate"
            style={{ transformOrigin: "left center" }}
            {...motions.shrink}
          >
            {cell.bar ? (
              <Meter share={cell.bar.share} label={cell.bar.label} />
            ) : cell.steps !== undefined ? (
              <Steps filled={cell.steps} />
            ) : (
              <>
                {cell.note}
                {cell.noteWide && (
                  <span className="hidden whitespace-pre @wide/window:inline">
                    {cell.noteWide}
                  </span>
                )}
              </>
            )}
          </motion.dd>
        )}
      </AnimatePresence>
    </div>
  );
}

/** Who took part lately, and the way into the 名单弹窗. */
function RosterEntry({
  roster,
  onOpen,
  motions,
}: {
  roster: Roster;
  onOpen: () => void;
  motions: CoverMotion;
}) {
  const rows =
    roster.kind === "draw"
      ? roster.winners
      : [...roster.rows].sort((a, b) => b.at - a.at);
  const label =
    roster.kind === "claims"
      ? "领取名单"
      : roster.kind === "draw"
        ? "中奖名单"
        : "报名名单";
  return (
    // A squircle like every other control: the hover tint and the focus
    // ring follow it.
    <Squircle radius={11}>
      <motion.button
        id="roster-entry"
        type="button"
        aria-haspopup="dialog"
        onClick={onOpen}
        layout="position"
        layoutDependency={motions.state}
        transition={motions.leaf.transition}
        className="hb-roster-entry flex h-8 shrink-0 items-center gap-2 px-1.5"
      >
        {rows.length > 0 && (
          <span aria-hidden="true" className="flex -space-x-1.5">
            {rows.slice(0, 5).map((row) => (
              <span key={row.id} className="hb-data-avatar rounded-full">
                <Avatar name={row.name} size={22} />
              </span>
            ))}
          </span>
        )}
        <span className="hb-roster-label text-[15px] font-medium">{label}</span>
        <ChevronRight className="size-4 opacity-70" aria-hidden="true" />
      </motion.button>
    </Squircle>
  );
}

/**
 * 公开数据 on the red cover (no card): amount, quantity and time, then the
 * roster entry. Fuzzy quantity hides counts the way production does. On the
 * small cover the three cells share one line, and on a wide window the
 * roster entry joins them.
 */
export function CoverData({
  activity,
  view,
  roster,
  onOpenRoster,
  motions,
}: {
  activity: HongbaoActivity;
  view: PublicView;
  roster: Roster;
  onOpenRoster: () => void;
  motions: CoverMotion;
}) {
  const small = motions.state === "small";
  return (
    <div
      className={cn(
        "relative flex w-full",
        small
          ? "flex-wrap items-center justify-center gap-x-6 gap-y-1 px-4"
          : "flex-col items-center gap-3 @wide/window:gap-4",
      )}
      data-hb-part="stats"
    >
      <dl
        className={cn(
          small
            ? "flex w-full flex-wrap items-baseline justify-center gap-x-5 gap-y-0.5 @wide/window:w-auto"
            : "grid w-full max-w-[34rem] grid-cols-3 gap-x-4 px-4 @wide/window:gap-x-8 @wide/window:px-0",
        )}
      >
        {coverCells(activity, view).map((cell) => (
          <DataCell key={cell.label} cell={cell} motions={motions} />
        ))}
      </dl>
      <RosterEntry roster={roster} onOpen={onOpenRoster} motions={motions} />
    </div>
  );
}
