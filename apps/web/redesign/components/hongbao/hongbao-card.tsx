import type { FixtureActivity } from "../../fixtures/activities";
import { endLabels, type PublicView } from "../../fixtures/hongbao";
import { cn } from "../../lib/cn";
import { clockLabel } from "../../lib/roster-time";
import { sealGlyphs } from "../../lib/seal";
import { Avatar } from "../ui/avatar";
import { radius, Squircle } from "../ui/squircle";
import { type ChipTone, StatusChip } from "../ui/status-chip";
import { coverCells } from "./cover-cells";

/** One line for how much is left, the way the cover's quantity cell says it. */
export function quantityLine(activity: FixtureActivity, view: PublicView) {
  const cell = coverCells(activity, view)[1];
  return `${cell.label} ${cell.value}`;
}

/** 进行中 / 已结束 (with why) for a list or a card. */
export function statusOf(view: PublicView) {
  if (!view.endReason) return { text: "进行中", tone: "success" as const };
  if (view.endReason === "settling")
    return { text: "开奖中", tone: "warning" as const };
  return { text: endLabels[view.endReason], tone: "neutral" as const };
}

/**
 * A 红包 as a card (红包广场): a small red cover with the sender and the
 * title, its seal on the curved edge, then the reward, what is left, the
 * deadline and the status on the paper.
 */
export function HongbaoCard({
  activity,
  view,
  onOpen,
  mine,
}: {
  activity: FixtureActivity;
  view: PublicView;
  onOpen: () => void;
  /** The viewer's part in it: 已领取 / 已报名 / 未中奖 / 你发的. */
  mine?: { text: string; tone: ChipTone } | null;
}) {
  const ended = view.ended && view.endReason !== "settling";
  const status = statusOf(view);
  const draw = activity.mode === "timed_draw";
  const seal = sealGlyphs;
  const glyph = ended ? seal.ended : draw ? seal.draw : seal.open;
  return (
    <Squircle radius={radius.card + 4}>
      <button
        type="button"
        onClick={onOpen}
        className="panel group grid h-full w-full content-start text-left transition-colors hover:bg-white/80"
      >
        <span
          className={cn(
            "hb-card-cover relative grid content-start gap-1.5 px-4 pt-3.5 pb-7",
            ended && "hb-ended",
          )}
        >
          <span className="flex min-w-0 items-center gap-1.5 text-[13px] text-cream-2">
            <Avatar name={activity.author.displayName} size={18} />
            <span className="truncate">
              {activity.author.displayName}的红包
            </span>
          </span>
          <span className="line-clamp-2 text-[17px] leading-snug font-semibold text-cream">
            {activity.title}
          </span>
          <span
            aria-hidden="true"
            className={cn(
              "hb-card-seal absolute top-full left-1/2 grid size-9 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full text-sm font-bold",
              ended && "hb-seal-muted",
            )}
          >
            {glyph}
          </span>
        </span>
        <span className="grid gap-1 px-4 pt-6 pb-4">
          <span className="truncate text-sm text-ink-2">
            {activity.rewardSummary}
          </span>
          <span className="truncate text-xs text-ink-3">
            {quantityLine(activity, view)}
            {!view.endReason &&
              ` · ${draw ? "开奖" : "截止"} ${clockLabel(view.deadlineAt)}`}
          </span>
          <span className="mt-2 flex flex-wrap items-center gap-1.5">
            <StatusChip tone={status.tone} dot>
              {status.text}
            </StatusChip>
            <StatusChip tone="neutral">
              {activity.participation === "password" ? "口令红包" : "无需口令"}
            </StatusChip>
            {mine && <StatusChip tone={mine.tone}>{mine.text}</StatusChip>}
          </span>
        </span>
      </button>
    </Squircle>
  );
}
