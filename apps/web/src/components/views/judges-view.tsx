import type { MyJudge } from "@hb/contracts";
import { Link } from "@tanstack/react-router";
import { Braces, ChevronRight } from "lucide-react";
import { useMyJudges } from "../../lib/judge";
import { useIdentity } from "../../lib/session";
import { EmptyNote, Page, PageHeader, Panel } from "../page/page";
import { PageLoad, queryLoad } from "../page/page-state";
import { radius, Squircle } from "../ui/squircle";

// 我的判定器 /judges (docs/judge-square-design.md §1 认得出来, §14.4): one's
// own, the latest changed first, each into its 判定器页. The 广场's other
// two tabs come with step 3.

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

/** 第 3 版 · 10月28日部署 · 开放过 2 个 */
function lineOf(judge: MyJudge) {
  return [
    judge.latest &&
      `第 ${judge.latest.n} 版 · ${dayLabel(Date.parse(judge.latest.deployedAt))}部署`,
    judge.opened > 0 && `开放过 ${judge.opened} 个`,
  ]
    .filter(Boolean)
    .join(" · ");
}

function JudgeRow({ judge }: { judge: MyJudge }) {
  return (
    <li>
      <Squircle radius={radius.row}>
        <Link
          to="/judges/$judgeId"
          params={{ judgeId: judge.id }}
          className="flex w-full items-center gap-3.5 p-3 text-left transition-colors hover:bg-fill-2"
        >
          <JudgeMark />
          <span className="grid min-w-0 flex-1 gap-0.5">
            <span className="truncate text-base font-medium text-ink">
              {judge.name}
            </span>
            {judge.description && (
              <span className="truncate text-sm text-ink-2">
                {judge.description}
              </span>
            )}
            <span className="truncate text-xs text-ink-3">{lineOf(judge)}</span>
          </span>
          <ChevronRight
            className="size-5 shrink-0 text-ink-3"
            aria-hidden="true"
          />
        </Link>
      </Squircle>
    </li>
  );
}

export function JudgesView() {
  const { user } = useIdentity();
  const query = useMyJudges(user?.id ?? null);
  const judges = query.data;
  return (
    <PageLoad load={queryLoad(query)}>
      <Page>
        <PageHeader title="我的判定器" refreshable />
        {judges && judges.length === 0 ? (
          <EmptyNote
            title="还没有判定器"
            text="在发红包第 2 步选“自己写一个”，部署以后就在这里。"
          />
        ) : (
          <Panel as="ul" className="grid gap-0.5 p-1.5">
            {judges?.map((judge) => (
              <JudgeRow key={judge.id} judge={judge} />
            ))}
          </Panel>
        )}
      </Page>
    </PageLoad>
  );
}
