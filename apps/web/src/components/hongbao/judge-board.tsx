import type { JudgeAnnouncement, PublicJudge } from "@hb/contracts";
import { useRouter } from "@tanstack/react-router";
import { useAtomValue } from "jotai";
import { ChevronRight, X } from "lucide-react";
import { AnimatePresence } from "motion/react";
import { useAnnouncements } from "../../lib/judge";
import {
  liveAnnouncementsAtom,
  liveViewAtom,
  mergeAnnouncements,
} from "../../lib/live-state";
import { switchOverlay } from "../../lib/overlay";
import { clockLabel, fullTime } from "../../lib/roster-time";
import { LazyListEnd, useQueryLazyList } from "../page/lazy-list";
import { PanelDialog } from "../shell/panel-dialog";
import { Avatar } from "../ui/avatar";
import { Button } from "../ui/button";
import { ListItem, Swap } from "../ui/reveal";
import { Squircle } from "../ui/squircle";
import { useHongbaoPageData } from "./use-hongbao-data";

// 红包状态 and 动态 (docs/judge-page-design.md §2, §11.3): what a 代码判定
// 红包's code wrote for everyone, guests too, under the seal's line — its
// sentence in a light panel, then the lines its judgments added, newest
// first. Read with the page; while it is open on the live channel, pushed
// with 已判定 N 次 (lib/live-state.ts), the later of the two shown.

/** What the board reads of a 红包: the page's or the read as it came. */
export type BoardActivity = { id: string; judge?: PublicJudge };

/** On the page; the rest in 动态's dialog. */
const ON_PAGE = 5;

/**
 * What the read and the pushes say together: the view, 动态's count and
 * lines. The 指令框's 红包状态 reads it too (my-judgments.tsx).
 */
export function useJudgeBoard(activity: BoardActivity) {
  const pushedView = useAtomValue(liveViewAtom);
  const pushedLines = useAtomValue(liveAnnouncementsAtom);
  const read = activity.judge?.view;
  const pushed = pushedView?.id === activity.id ? pushedView.view : undefined;
  const view =
    pushed && (!read || Date.parse(pushed.at) >= Date.parse(read.at))
      ? pushed
      : read;
  const lines = pushedLines?.id === activity.id ? pushedLines : null;
  const shown = activity.judge?.announcements;
  return {
    view,
    total: Math.max(shown?.total ?? 0, lines?.total ?? 0),
    lines: mergeAnnouncements(shown?.latest, lines?.items),
  };
}

/** One line: who was judged and when, then what the code wrote. */
function AnnouncementRow({ item }: { item: JudgeAnnouncement }) {
  const at = Date.parse(item.at);
  return (
    <ListItem>
      <div className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-2.5 py-1.5">
        <Avatar
          name={item.user.displayName}
          src={item.user.avatarUrl}
          size={28}
          className="row-span-2 mt-0.5"
        />
        <div className="flex min-w-0 items-baseline justify-between gap-3">
          <span className="truncate text-sm font-medium text-ink">
            {item.user.displayName}
          </span>
          <time
            dateTime={item.at}
            title={fullTime(at)}
            className="shrink-0 text-xs text-ink-3 tabular-nums"
          >
            {clockLabel(at)}
          </time>
        </div>
        <p className="text-sm break-words text-ink-2">{item.text}</p>
      </div>
    </ListItem>
  );
}

/**
 * Under the seal's line: 红包状态 when the code wrote a sentence for it,
 * 动态 when it wrote any line; nothing for a 红包 with neither.
 */
export function JudgeBoard({ activity }: { activity: BoardActivity }) {
  const router = useRouter();
  const { view, total, lines } = useJudgeBoard(activity);
  const summary = view?.summary;
  if (!summary && total === 0) return null;
  return (
    <div className="grid gap-6" data-hb-part="judge-board">
      {summary && (
        <section aria-labelledby="judge-state-title">
          <Squircle radius={14}>
            <div className="grid gap-1 bg-fill-2 px-4 py-3">
              <h2
                id="judge-state-title"
                className="text-xs font-medium text-ink-3"
              >
                红包状态
              </h2>
              <Swap id={summary}>
                <p
                  className="text-base leading-snug break-words text-ink"
                  aria-live="polite"
                >
                  {summary}
                </p>
              </Swap>
            </div>
          </Squircle>
        </section>
      )}
      {total > 0 && (
        <section className="grid gap-1" aria-labelledby="announcements-title">
          <div className="flex min-h-9 items-center justify-between gap-3">
            <h2
              id="announcements-title"
              className="text-sm font-medium text-ink-3"
            >
              动态
            </h2>
            {total > ON_PAGE && (
              <Button
                id="announcements-all"
                variant="ghost"
                size="xs"
                aria-haspopup="dialog"
                className="-mr-2 gap-0.5 pr-1.5"
                onClick={() =>
                  switchOverlay(router, { panel: "announcements" })
                }
              >
                全部 {total} 条
                <ChevronRight aria-hidden="true" />
              </Button>
            )}
          </div>
          <ul className="flex flex-col">
            <AnimatePresence initial={false}>
              {lines.slice(0, ON_PAGE).map((item) => (
                <AnnouncementRow key={item.n} item={item} />
              ))}
            </AnimatePresence>
          </ul>
        </section>
      )}
    </div>
  );
}

function AnnouncementsBody({
  activityId,
  onClose,
}: {
  activityId: string;
  onClose: () => void;
}) {
  const activity = useHongbaoPageData(activityId).data?.activity;
  const pushedLines = useAtomValue(liveAnnouncementsAtom);
  const query = useAnnouncements(activityId, true);
  const list = useQueryLazyList({
    hasNextPage: query.hasNextPage,
    isFetchingNextPage: query.isFetchingNextPage,
    isFetchNextPageError: query.isFetchNextPageError,
    fetchNextPage: query.fetchNextPage,
    pageCount: query.data?.pages.length ?? 0,
  });
  const pushed = pushedLines?.id === activityId ? pushedLines : null;
  const read = query.data?.pages.flatMap((page) => page.items) ?? [];
  // Lines newer than the dialog's first page — pushed, or on the page —
  // go on top; before it is in, the page's latest stand for it.
  const newest = read[0]?.n ?? -1;
  const items = mergeAnnouncements(
    read,
    [
      ...(pushed?.items ?? []),
      ...(activity?.judge?.announcements?.latest ?? []),
    ].filter((item) => item.n > newest),
  );
  const total = Math.max(
    query.data?.pages[0]?.total ?? 0,
    pushed?.total ?? 0,
    activity?.judge?.announcements?.total ?? 0,
  );
  return (
    <>
      <header className="flex items-center justify-between gap-3 px-5 pt-4 pb-3">
        <h2
          id="announcements-dialog-title"
          className="text-lg font-semibold text-ink"
        >
          动态 · {total} 条
        </h2>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="关闭"
          className="-mr-2 shrink-0"
          onClick={onClose}
        >
          <X />
        </Button>
      </header>
      <div className="view-scroll relative min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 pb-5">
        <ul className="flex flex-col">
          {/* The first page replaces the page's lines at once; only lines
              that come after it slide in. */}
          <AnimatePresence initial={false} key={query.data ? "read" : "page"}>
            {items.map((item) => (
              <AnnouncementRow key={item.n} item={item} />
            ))}
          </AnimatePresence>
        </ul>
        <LazyListEnd list={list} done="已全部加载" />
      </div>
    </>
  );
}

/** 动态 in full: every line, twenty more as it scrolls. */
export function AnnouncementsDialog() {
  return (
    <PanelDialog
      panel="announcements"
      triggerId="announcements-all"
      labelledBy="announcements-dialog-title"
      width="30rem"
    >
      {(activityId, close) => (
        <AnnouncementsBody activityId={activityId} onClose={close} />
      )}
    </PanelDialog>
  );
}
