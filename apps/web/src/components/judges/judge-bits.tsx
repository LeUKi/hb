import type { JudgeStats, SquareJudge } from "@hb/contracts";
import { BookOpen, Bot, Braces, FolderGit2, Globe } from "lucide-react";
import { cn } from "../../lib/cn";
import { KIT_URL } from "../../lib/judge";
import { Avatar } from "../ui/avatar";
import { radius, Squircle } from "../ui/squircle";
import { TagHint } from "../ui/tag-hint";

// What every list of 判定器 shares (docs/judge-square-design.md §8,
// §15.4): its mark, the day it was deployed, whose it is, its numbers and
// its tags; and where writing one is told (§16.1).

/** "10月28日" (another year's: "2025年10月28日"). */
export function dayLabel(at: number, now = Date.now()) {
  const date = new Date(at);
  const day = `${date.getMonth() + 1}月${date.getDate()}日`;
  return date.getFullYear() === new Date(now).getFullYear()
    ? day
    : `${date.getFullYear()}年${day}`;
}

/** No icon of its own (§6): 代码判定's braces, in its lacquer. */
export function JudgeMark() {
  return (
    <Squircle radius={11}>
      <span className="hb-lacquer-chip grid size-10 shrink-0 place-items-center">
        <Braces className="size-[18px]" aria-hidden="true" />
      </span>
    </Squircle>
  );
}

/** 发过 3 个红包 · 判定 120 次 · 领到 15 人次, or 还没发过红包. */
export function statsLine(stats: JudgeStats) {
  return stats.hongbao > 0
    ? `发过 ${stats.hongbao} 个红包 · 判定 ${stats.judged} 次 · 领到 ${stats.claimed} 人次`
    : "还没发过红包";
}

/**
 * Whose it is: @作者 with their picture, or for a 精选 the 站长 improved
 * on another's, 站长精选 · 基于 @作者 (§9).
 */
export function JudgeSource({ judge }: { judge: SquareJudge }) {
  if (judge.featured && judge.bySiteOwner && judge.basedOn)
    return <span>站长精选 · 基于 @{judge.basedOn.username}</span>;
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      <Avatar
        name={judge.author.displayName}
        src={judge.author.avatarUrl}
        size={16}
      />
      <span className="truncate">@{judge.author.username}</span>
    </span>
  );
}

const tagClass =
  "inline-flex h-6 shrink-0 items-center px-2 text-xs font-medium whitespace-nowrap";

/** What a 旧判定器 is (docs/multi-prize-design.md §3.6). */
export const OLD_JUDGE_HINT =
  "按旧规则（有份数）写的判定器，要按新规则重新跑一遍测试才能发新红包。";

/**
 * 精选, 联网, 带附带网页 and 旧判定器, each explaining itself (§15.4;
 * judge-page §11.3; multi-prize §3.6).
 */
export function JudgeTags({ judge }: { judge: SquareJudge }) {
  if (!judge.featured && !judge.network && !judge.page && !judge.old)
    return null;
  return (
    <span className="flex flex-wrap gap-1.5">
      {judge.old && (
        <Squircle radius={radius.tag}>
          <TagHint
            hint={OLD_JUDGE_HINT}
            className={cn(tagClass, "bg-fill-2 text-ink-2")}
          >
            旧判定器
          </TagHint>
        </Squircle>
      )}
      {judge.featured && (
        <Squircle radius={radius.tag}>
          <TagHint
            hint="站长挑选或改进过的判定器。"
            className={cn(tagClass, "bg-gold-soft text-gold-ink")}
          >
            精选
          </TagHint>
        </Squircle>
      )}
      {judge.network && (
        <Squircle radius={radius.tag}>
          <TagHint
            hint="会把领的人提交的内容发到别的服务器，由对方决定发不发、发多少。"
            className={cn(tagClass, "bg-warning-soft text-warning")}
          >
            联网
          </TagHint>
        </Squircle>
      )}
      {judge.page && (
        <Squircle radius={radius.tag}>
          <TagHint
            hint="用它发红包时，判定器带的网页一起带上。"
            className={cn(tagClass, "gap-1 bg-fill-2 text-ink-2")}
          >
            <Globe className="size-3" aria-hidden="true" />
            带附带网页
          </TagHint>
        </Squircle>
      )}
    </span>
  );
}

/**
 * 开发文档, 给 AI 的说明 and 本地开发包 (§16.1), where a 判定器 is
 * written: in a new tab, so what is half written stays.
 */
export function JudgeHelpLinks({ className }: { className?: string }) {
  return (
    <div className={cn("flex flex-wrap gap-x-4 gap-y-1", className)}>
      {[
        { href: "/help/code", icon: BookOpen, label: "开发文档" },
        { href: "/help/code#ai", icon: Bot, label: "给 AI 的说明" },
        { href: KIT_URL, icon: FolderGit2, label: "本地开发包" },
      ].map((entry) => (
        <a
          key={entry.href}
          href={entry.href}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1 text-sm text-accent-ink hover:underline"
        >
          <entry.icon className="size-4" aria-hidden="true" />
          {entry.label} ↗
        </a>
      ))}
    </div>
  );
}
