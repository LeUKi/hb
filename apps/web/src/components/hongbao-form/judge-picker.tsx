import type { MyJudge } from "@hb/contracts";
import { Braces } from "lucide-react";
import { useId } from "react";
import { cn } from "../../lib/cn";
import { Button } from "../ui/button";
import { radius, Squircle } from "../ui/squircle";

// 发红包第 2 步“判定器” (docs/judge-square-design.md §6, §14.4): before a
// pick, 我的判定器 as cards with 自己写一个 under them; after it, one card
// with 查看代码 and 换一个. The 站长精选 and the 广场 come with the 广场.

/** 我的判定器 shown here: the newest three (the rest from the 广场 picker). */
const SHOWN = 3;

/** 第 3 版 · 开放过 2 个: a card's second line. */
const usedLine = (judge: MyJudge) =>
  judge.usable
    ? `第 ${judge.usable.n} 版${judge.opened > 0 ? ` · 开放过 ${judge.opened} 个` : ""}`
    : "";

/** No icon of its own (§6): 代码判定's braces, in its lacquer. */
function Mark() {
  return (
    <Squircle radius={10}>
      <span className="hb-lacquer-chip grid size-8 shrink-0 place-items-center">
        <Braces className="size-[18px]" aria-hidden="true" />
      </span>
    </Squircle>
  );
}

export function JudgePicker({
  judges,
  busy,
  onPick,
  onWrite,
}: {
  /** One's own with a version to use, newest first. */
  judges: MyJudge[];
  /** A pick on its way: the cards wait. */
  busy: boolean;
  onPick: (judge: MyJudge) => void;
  onWrite: () => void;
}) {
  const labelId = useId();
  return (
    <div className="flex flex-col gap-3">
      {judges.length > 0 && (
        <fieldset
          aria-labelledby={labelId}
          className="@container/judges flex min-w-0 flex-col gap-2.5"
        >
          <p id={labelId} className="px-1 text-xs text-ink-3">
            我的判定器
          </p>
          <div className="grid gap-2.5 @min-[22rem]/judges:grid-cols-2 @min-[40rem]/judges:grid-cols-3">
            {judges.slice(0, SHOWN).map((judge) => (
              <Squircle key={judge.id} radius={radius.card}>
                <button
                  type="button"
                  aria-disabled={busy || undefined}
                  onClick={() => {
                    if (!busy) onPick(judge);
                  }}
                  className="choice grid h-full content-start gap-1.5 p-3 text-left"
                >
                  <span className="flex min-w-0 items-center gap-2.5">
                    <Mark />
                    <span className="truncate text-base font-semibold text-ink">
                      {judge.name}
                    </span>
                  </span>
                  {judge.description && (
                    <span className="line-clamp-2 text-sm text-ink-2">
                      {judge.description}
                    </span>
                  )}
                  <span className="text-xs text-ink-3">{usedLine(judge)}</span>
                </button>
              </Squircle>
            ))}
          </div>
        </fieldset>
      )}
      <div>
        <Button variant="ghost" size="sm" className="-ml-2" onClick={onWrite}>
          自己写一个
        </Button>
      </div>
    </div>
  );
}

/**
 * The pick, folded into one card (§6 挑好以后): its name, whose it is,
 * which version and its line; 查看代码 and 换一个 on its right, and a
 * newer version to change to when there is one.
 */
export function PickedJudge({
  name,
  description,
  n,
  newer,
  locked,
  busy,
  onView,
  onSwap,
  onNewer,
}: {
  name: string;
  description: string;
  n: number;
  /** A newer version of it that a 红包 can open with. */
  newer?: number;
  locked: boolean;
  busy: boolean;
  onView: () => void;
  onSwap: () => void;
  onNewer: () => void;
}) {
  return (
    <Squircle radius={radius.card}>
      <div className="grid gap-2 bg-fill p-3.5">
        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2">
          <span className="flex min-w-0 flex-1 items-center gap-2.5">
            <Mark />
            <span className="grid min-w-0">
              <span className="flex min-w-0 items-baseline gap-2">
                <span className="truncate text-base font-semibold text-ink">
                  {name}
                </span>
                <span className="shrink-0 text-xs text-ink-3">
                  我的 · 第 {n} 版
                </span>
              </span>
              {description && (
                <span className="truncate text-sm text-ink-2">
                  {description}
                </span>
              )}
            </span>
          </span>
          <span className="flex shrink-0 gap-1.5">
            <Button size="xs" onClick={onView}>
              查看代码
            </Button>
            {!locked && (
              <Button
                size="xs"
                aria-disabled={busy || undefined}
                onClick={() => {
                  if (!busy) onSwap();
                }}
              >
                换一个
              </Button>
            )}
          </span>
        </div>
        {!locked && newer !== undefined && (
          <div
            className={cn(
              "flex flex-wrap items-center gap-x-3 gap-y-1 border-line border-t pt-2 text-sm text-ink-2",
            )}
          >
            <span className="min-w-0 flex-1">有第 {newer} 版</span>
            <Button
              size="xs"
              aria-disabled={busy || undefined}
              onClick={() => {
                if (!busy) onNewer();
              }}
            >
              换成第 {newer} 版
            </Button>
          </div>
        )}
      </div>
    </Squircle>
  );
}
