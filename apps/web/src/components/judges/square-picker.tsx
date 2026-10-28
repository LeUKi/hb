import { X } from "lucide-react";
import { useId, useState } from "react";
import { useMyJudges, useSquareJudges } from "../../lib/judge";
import { LazyListEnd, useQueryLazyList } from "../page/lazy-list";
import { WindowDialog } from "../shell/window-dialog";
import { Button } from "../ui/button";
import { Segmented } from "../ui/field";
import { radius, Squircle } from "../ui/squircle";
import { JudgeMark } from "./judge-bits";
import { SquareJudgeCard } from "./square-card";

// 去判定器广场挑一个 › (docs/judge-square-design.md §6, §15.4): the 广场
// over the 发红包 form — its tabs, its order, its cards with 用这个 and
// 查看 ↗ — so what is filled in stays; and the 广场 in a new tab.

type Tab = "featured" | "all" | "mine";

export function SquarePicker({
  open,
  onClose,
  userId,
  busy,
  onPick,
}: {
  open: boolean;
  onClose: () => void;
  userId: string;
  /** A pick on its way: the cards wait. */
  busy: boolean;
  onPick: (judgeId: string) => void;
}) {
  const titleId = useId();
  const [tab, setTab] = useState<Tab>("featured");
  const [sort, setSort] = useState<"recent" | "used">("recent");
  const featured = useSquareJudges(
    "featured",
    "recent",
    open && tab === "featured",
  );
  const all = useSquareJudges("all", sort, open && tab === "all");
  const mine = useMyJudges(userId, open && tab === "mine");
  const square = tab === "all" ? all : featured;
  const cards = square.data?.pages.flatMap((page) => page.items) ?? [];
  const own = (mine.data ?? []).filter((judge) => judge.usable !== null);
  const list = useQueryLazyList({
    hasNextPage: all.hasNextPage,
    isFetchingNextPage: all.isFetchingNextPage,
    isFetchNextPageError: all.isFetchNextPageError,
    fetchNextPage: all.fetchNextPage,
    pageCount: all.data?.pages.length ?? 0,
  });
  const shown = tab === "mine" ? mine : square;
  const empty =
    tab === "mine"
      ? "还没有判定器"
      : tab === "featured"
        ? "还没有精选的判定器"
        : "广场上还没有判定器";
  return (
    <WindowDialog
      open={open}
      onClose={onClose}
      labelledBy={titleId}
      width="48rem"
    >
      <div className="flex max-h-[min(44rem,85dvh)] flex-col">
        <header className="grid gap-3 px-5 pt-4 pb-3">
          <div className="flex items-center justify-between gap-3">
            <h2 id={titleId} className="text-lg font-semibold text-ink">
              判定器广场
            </h2>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="关闭"
              className="-mr-2"
              onClick={onClose}
            >
              <X />
            </Button>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <Segmented
              label="判定器"
              value={tab}
              onChange={setTab}
              options={[
                { value: "featured", label: "站长精选" },
                { value: "all", label: "大家做的" },
                { value: "mine", label: "我的" },
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
        </header>
        <div className="view-scroll min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 pb-4">
          {shown.data === undefined ? (
            <p role="status" className="py-10 text-center text-sm text-ink-3">
              {shown.isError ? "读取失败" : "正在读取…"}
            </p>
          ) : (tab === "mine" ? own.length : cards.length) === 0 ? (
            <p className="py-10 text-center text-sm text-ink-3">{empty}</p>
          ) : tab === "mine" ? (
            <ul className="grid grid-cols-[repeat(auto-fill,minmax(15rem,1fr))] gap-2.5">
              {own.map((judge) => (
                <li key={judge.id}>
                  <Squircle radius={radius.card}>
                    <button
                      type="button"
                      aria-disabled={busy || undefined}
                      onClick={() => {
                        if (!busy) onPick(judge.id);
                      }}
                      className="choice flex h-full w-full items-center gap-3 p-3 text-left"
                    >
                      <JudgeMark />
                      <span className="grid min-w-0 flex-1 gap-0.5">
                        <span className="truncate text-base font-semibold text-ink">
                          {judge.name}
                        </span>
                        {judge.description && (
                          <span className="truncate text-sm text-ink-2">
                            {judge.description}
                          </span>
                        )}
                      </span>
                    </button>
                  </Squircle>
                </li>
              ))}
            </ul>
          ) : (
            <>
              <ul className="grid grid-cols-[repeat(auto-fill,minmax(15rem,1fr))] gap-3">
                {cards.map((judge) => (
                  <li key={judge.id}>
                    <SquareJudgeCard
                      judge={judge}
                      signedIn
                      busy={busy}
                      onPick={() => onPick(judge.id)}
                    />
                  </li>
                ))}
              </ul>
              {tab === "all" && <LazyListEnd list={list} done="已全部加载" />}
            </>
          )}
        </div>
        <footer className="border-line border-t px-5 py-3">
          <a
            href="/judges"
            target="_blank"
            rel="noreferrer"
            className="text-sm text-accent-ink hover:underline"
          >
            在新页面看判定器广场 ↗
          </a>
        </footer>
      </div>
    </WindowDialog>
  );
}
