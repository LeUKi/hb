import type { MyJudge, SquareJudge } from "@hb/contracts";
import { Link, useNavigate } from "@tanstack/react-router";
import { ChevronRight } from "lucide-react";
import { useMyJudges, useSquareJudges } from "../../lib/judge";
import { useIdentity } from "../../lib/session";
import {
  dayLabel,
  JudgeMark,
  JudgeSource,
  JudgeTags,
  statsLine,
} from "../judges/judge-bits";
import { useOmniboxController } from "../omnibox/use-omnibox-controller";
import { LazyListEnd, useQueryLazyList } from "../page/lazy-list";
import { EmptyNote, Page, PageHeader, Panel } from "../page/page";
import {
  Bone,
  PageLoad,
  PageSkeleton,
  queryLoad,
  ResultLoad,
  resultOf,
} from "../page/page-state";
import { useSearchChoice } from "../shell/use-search-choice";
import { Button } from "../ui/button";
import { ButtonLink } from "../ui/button-link";
import { Segmented } from "../ui/field";
import { radius, Squircle } from "../ui/squircle";

// 判定器广场 /judges (docs/judge-square-design.md §8, §15.4): 站长精选,
// 大家做的 (最近, 用得最多) and, signed in, 我的 — one's own, the latest
// changed first. Anyone may look; 用它发红包 and 自己写一个 ask a guest to
// log in first.

type Tab = "featured" | "all" | "mine";
type Sort = "recent" | "used";

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

function MyJudgeRow({ judge }: { judge: MyJudge }) {
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

/**
 * A 判定器 in the 广场 (§8 卡片): what it is, whose, its numbers and tags;
 * 用它发红包 and 查看.
 */
export function SquareJudgeCard({
  judge,
  signedIn,
}: {
  judge: SquareJudge;
  signedIn: boolean;
}) {
  const navigate = useNavigate();
  const { openAccount } = useOmniboxController();
  return (
    <Squircle radius={radius.card}>
      <article className="panel grid h-full content-start gap-2.5 p-4">
        <div className="flex min-w-0 items-center gap-3">
          <JudgeMark />
          <div className="grid min-w-0 flex-1 gap-0.5">
            <h3 className="truncate text-base font-semibold text-ink">
              {judge.name}
            </h3>
            <span className="text-xs text-ink-3">
              <JudgeSource judge={judge} />
            </span>
          </div>
        </div>
        {judge.description && (
          <p className="line-clamp-2 text-sm text-ink-2">{judge.description}</p>
        )}
        <p className="text-xs text-ink-3">{statsLine(judge.stats)}</p>
        <JudgeTags judge={judge} />
        <div className="mt-1 flex flex-wrap gap-2 self-end">
          {signedIn ? (
            <ButtonLink
              variant="primary"
              href={`/new?judge=${encodeURIComponent(judge.id)}`}
              onGo={() =>
                void navigate({ to: "/new", search: { judge: judge.id } })
              }
            >
              用它发红包
            </ButtonLink>
          ) : (
            <Button variant="primary" size="sm" onClick={openAccount}>
              用它发红包
            </Button>
          )}
          <ButtonLink
            href={`/judges/${encodeURIComponent(judge.id)}`}
            onGo={() =>
              void navigate({
                to: "/judges/$judgeId",
                params: { judgeId: judge.id },
              })
            }
          >
            查看
          </ButtonLink>
        </div>
      </article>
    </Squircle>
  );
}

/** Grey cards where the 判定器 go, while a tab is read first. */
function CardsSkeleton() {
  return (
    <div
      aria-hidden="true"
      className="grid grid-cols-[repeat(auto-fill,minmax(17rem,1fr))] gap-3"
    >
      {[0, 1, 2].map((card) => (
        <Bone key={card} className="h-48 w-full" radius={radius.card} />
      ))}
    </div>
  );
}

export function JudgesView() {
  const identity = useIdentity();
  if (!identity.ready) return <PageSkeleton />;
  return <Square userId={identity.user?.id ?? null} />;
}

function Square({ userId }: { userId: string | null }) {
  const navigate = useNavigate();
  const { openAccount } = useOmniboxController();
  const tabs: Tab[] = userId
    ? ["featured", "all", "mine"]
    : ["featured", "all"];
  const [tab, setTab] = useSearchChoice<Tab>("tab", "featured", tabs);
  const [sort, setSort] = useSearchChoice<Sort>("sort", "recent", [
    "recent",
    "used",
  ]);
  const featured = useSquareJudges("featured", "recent", tab === "featured");
  const all = useSquareJudges("all", sort, tab === "all");
  const mine = useMyJudges(userId, tab === "mine");
  const square = tab === "all" ? all : featured;
  const cards = square.data?.pages.flatMap((page) => page.items) ?? [];
  const list = useQueryLazyList({
    hasNextPage: all.hasNextPage,
    isFetchingNextPage: all.isFetchingNextPage,
    isFetchNextPageError: all.isFetchNextPageError,
    fetchNextPage: all.fetchNextPage,
    pageCount: all.data?.pages.length ?? 0,
  });
  const shown = tab === "mine" ? mine : square;
  const own = mine.data ?? [];
  return (
    // The title and the tabs stay once shown; each tab loads in place.
    <PageLoad load={queryLoad(shown)} frame>
      <Page width="wide">
        <PageHeader
          refreshable
          title="判定器广场"
          description="挑一个判定器，填几项参数就能发红包。"
          actions={
            userId ? (
              <ButtonLink
                href="/judges/new"
                onGo={() => void navigate({ to: "/judges/new" })}
              >
                自己写一个
              </ButtonLink>
            ) : (
              <Button size="sm" onClick={openAccount}>
                自己写一个
              </Button>
            )
          }
        />
        <div className="flex flex-wrap items-center justify-between gap-3 px-1">
          <Segmented
            label="判定器"
            value={tab}
            onChange={setTab}
            options={[
              { value: "featured", label: "站长精选" },
              { value: "all", label: "大家做的" },
              ...(userId ? [{ value: "mine" as const, label: "我的" }] : []),
            ]}
          />
          {tab === "all" && (
            <Segmented
              label="排序"
              size="sm"
              value={sort}
              onChange={setSort}
              options={[
                { value: "recent", label: "最近" },
                { value: "used", label: "用得最多" },
              ]}
            />
          )}
        </div>
        {tab === "mine" ? (
          <ResultLoad
            id={`mine:${own.length === 0 ? "empty" : "rows"}`}
            load={resultOf(mine)}
          >
            {own.length === 0 ? (
              <EmptyNote
                title="还没有判定器"
                text="在发红包第 2 步选“自己写一个”，部署以后就在这里。"
              />
            ) : (
              <Panel as="ul" className="grid gap-0.5 p-1.5">
                {own.map((judge) => (
                  <MyJudgeRow key={judge.id} judge={judge} />
                ))}
              </Panel>
            )}
          </ResultLoad>
        ) : (
          <ResultLoad
            id={`${tab}:${tab === "all" ? sort : ""}:${cards.length === 0 ? "empty" : "cards"}`}
            load={resultOf(square)}
            skeleton={<CardsSkeleton />}
          >
            {cards.length === 0 ? (
              tab === "featured" ? (
                <EmptyNote title="还没有精选的判定器" />
              ) : (
                <EmptyNote
                  title="广场上还没有判定器"
                  text="在自己的判定器页打开“加入判定器广场”，开放过红包以后就在这里。"
                />
              )
            ) : (
              <>
                <ul className="grid grid-cols-[repeat(auto-fill,minmax(17rem,1fr))] gap-3">
                  {cards.map((judge) => (
                    <li key={judge.id}>
                      <SquareJudgeCard
                        judge={judge}
                        signedIn={Boolean(userId)}
                      />
                    </li>
                  ))}
                </ul>
                {tab === "all" && <LazyListEnd list={list} done="已全部加载" />}
              </>
            )}
          </ResultLoad>
        )}
      </Page>
    </PageLoad>
  );
}
