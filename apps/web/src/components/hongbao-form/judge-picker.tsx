import type { MyJudge, SquareJudge } from "@hb/contracts";
import { Braces, ChevronRight } from "lucide-react";
import { useId } from "react";
import { cn } from "../../lib/cn";
import { Button } from "../ui/button";
import { radius, Squircle } from "../ui/squircle";

// 发红包第 2 步“判定器” (docs/judge-square-design.md §6, §14.4, §15.4):
// before a pick, 站长精选 and 我的判定器 as cards, then 去判定器广场挑一个
// and 自己写一个; after it, one card with 查看代码 and 换一个.

/** 我的判定器 shown here: the newest three (the rest from the 广场 picker). */
const SHOWN = 3;
/** 站长精选 shown here: six at most, three a row. */
const FEATURED = 6;

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

/** 精选's third line: whose, or the 站长's copy of whose (§15.4). */
const sourceLine = (judge: SquareJudge) =>
  judge.bySiteOwner && judge.basedOn
    ? `站长精选 · 基于 @${judge.basedOn.username}`
    : `@${judge.author.username}`;

export function JudgePicker({
  featured,
  judges,
  busy,
  onPickFeatured,
  onPick,
  onBrowse,
  onWrite,
}: {
  /** 站长精选, in the 站长's order. */
  featured: SquareJudge[];
  /** One's own with a version to use, newest first. */
  judges: MyJudge[];
  /** A pick on its way: the cards wait. */
  busy: boolean;
  onPickFeatured: (judge: SquareJudge) => void;
  onPick: (judge: MyJudge) => void;
  /** 去判定器广场挑一个: the 广场 over the form. */
  onBrowse: () => void;
  onWrite: () => void;
}) {
  const labelId = useId();
  const featuredId = useId();
  return (
    <div className="flex flex-col gap-3">
      {featured.length > 0 && (
        <fieldset
          aria-labelledby={featuredId}
          className="@container/featured flex min-w-0 flex-col gap-2.5"
        >
          <p id={featuredId} className="px-1 text-xs text-ink-3">
            站长精选
          </p>
          <div className="grid gap-2.5 @min-[22rem]/featured:grid-cols-2 @min-[40rem]/featured:grid-cols-3">
            {featured.slice(0, FEATURED).map((judge) => (
              <Squircle key={judge.id} radius={radius.card}>
                <button
                  type="button"
                  aria-disabled={busy || undefined}
                  onClick={() => {
                    if (!busy) onPickFeatured(judge);
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
                  <span className="flex min-w-0 items-center gap-1.5 text-xs text-ink-3">
                    <span className="truncate">{sourceLine(judge)}</span>
                    {judge.network && (
                      <Squircle radius={radius.tag}>
                        <span className="inline-flex h-5 shrink-0 items-center bg-warning-soft px-1.5 text-xs font-medium text-warning">
                          联网
                        </span>
                      </Squircle>
                    )}
                  </span>
                </button>
              </Squircle>
            ))}
          </div>
        </fieldset>
      )}
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
      <div className="flex flex-wrap gap-x-2">
        <Button
          variant="ghost"
          size="sm"
          className="-ml-2 gap-0.5"
          onClick={onBrowse}
        >
          去判定器广场挑一个
          <ChevronRight aria-hidden="true" />
        </Button>
        <Button variant="ghost" size="sm" onClick={onWrite}>
          自己写一个
        </Button>
      </div>
    </div>
  );
}

/** 用它发红包 (§6): the card while the 判定器 it names is read. */
export function LoadingJudge() {
  return (
    <Squircle radius={radius.card}>
      <p
        role="status"
        className="flex min-w-0 items-center gap-2.5 bg-fill p-3.5 text-sm text-ink-3"
      >
        <Mark />
        正在读取判定器…
      </p>
    </Squircle>
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
  source = "我的",
  n,
  newer,
  notice,
  locked,
  busy,
  onView,
  onSwap,
  onNewer,
}: {
  name: string;
  description: string;
  /** Whose (§15.4): 我的, 站长精选 or @作者. */
  source?: string;
  n: number;
  /** Another's left the 广场, or was taken down (§15.4). */
  notice?: { tone: "quiet" | "danger"; text: string };
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
      <div
        id="hb-judge-picked"
        tabIndex={-1}
        className="grid gap-2 bg-fill p-3.5 outline-none"
      >
        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2">
          <span className="flex min-w-0 flex-1 items-center gap-2.5">
            <Mark />
            <span className="grid min-w-0">
              {/* Narrow, whose and which version go under its name. */}
              <span className="flex min-w-0 flex-wrap items-baseline gap-x-2">
                <span className="max-w-full truncate text-base font-semibold text-ink">
                  {name}
                </span>
                <span className="shrink-0 text-xs text-ink-3">
                  {source} · 第 {n} 版
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
        {notice && (
          <p
            className={cn(
              "border-line border-t pt-2 text-sm",
              notice.tone === "danger" ? "text-danger" : "text-ink-2",
            )}
          >
            {notice.text}
          </p>
        )}
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
