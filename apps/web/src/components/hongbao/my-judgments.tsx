import type { JudgeNote, MyJudgment } from "@hb/contracts";
import { useRouter } from "@tanstack/react-router";
import { atom, useAtom, useSetAtom } from "jotai";
import { ChevronRight, X } from "lucide-react";
import { AnimatePresence } from "motion/react";
import { useEffect } from "react";
import { useMyJudgments } from "../../lib/judge";
import { switchOverlay } from "../../lib/overlay";
import { clockSeconds } from "../../lib/roster-time";
import { useSessionUser } from "../../lib/session";
import { LazyListEnd, useQueryLazyList } from "../page/lazy-list";
import { PanelDialog } from "../shell/panel-dialog";
import { Avatar } from "../ui/avatar";
import { Button } from "../ui/button";
import { RollingText } from "../ui/morph-label";
import { ListItem } from "../ui/reveal";
import { Squircle } from "../ui/squircle";
import { PasswordText, RevealToggle } from "./password-text";
import { useHongbaoPageData } from "./use-hongbao-data";

/** On the page; the rest are in the dialog (05 §3). */
const ON_PAGE = 3;

const notes: Record<JudgeNote, string> = {
  cap: "按上限发",
  floor: "按每份至少发",
  last: "最后一份，发完剩下的",
};

/**
 * Whose inputs are shown, page and dialog alike: the 红包's id. Kept in
 * memory only, for that 红包, and only while its page is open: not
 * remembered, as the eye of a 口令 (05 §9).
 */
const shownAtom = atom<string | null>(null);

function useShown(activityId: string, ended: boolean) {
  const [shownFor, setShownFor] = useAtom(shownAtom);
  const shown = shownFor === activityId;
  return {
    shown: ended || shown,
    toggle: ended
      ? null
      : () =>
          setShownFor((current) =>
            current === activityId ? null : activityId,
          ),
  };
}

function Row({
  item,
  activityId,
  shown,
}: {
  item: MyJudgment;
  activityId: string;
  shown: boolean;
}) {
  return (
    <ListItem>
      <Squircle radius={12}>
        <div className="grid gap-1 bg-fill px-3.5 py-2.5">
          <div className="flex items-baseline justify-between gap-3">
            <span className="text-xs text-ink-3 tabular-nums">
              第 {item.attempt} 次 · {clockSeconds(Date.parse(item.at))}
            </span>
            {item.amount ? (
              <span className="shrink-0 text-sm font-medium text-success tabular-nums">
                领到 {item.amount} LDC
              </span>
            ) : (
              <span className="shrink-0 text-sm text-ink-3">没领到</span>
            )}
          </div>
          <PasswordText
            text={item.input}
            shown={shown}
            seed={`${activityId}:judgment`}
            index={item.attempt}
            wrap
            className="text-base text-ink"
          />
          {item.message && (
            <p className="text-sm text-ink-2">
              <span className="text-ink-3">代码的回复：</span>
              {item.message}
            </p>
          )}
          {item.note && (
            <p className="text-sm text-ink-2">{notes[item.note]}</p>
          )}
        </div>
      </Squircle>
    </ListItem>
  );
}

/** “仅你可见” and the eye, beside the title on the page and in the dialog. */
function Privacy({
  eye,
}: {
  eye: { shown: boolean; toggle: (() => void) | null };
}) {
  return (
    <span className="flex shrink-0 items-center gap-1">
      <span className="text-xs text-ink-3">仅你可见</span>
      {eye.toggle && (
        <RevealToggle
          size="icon-sm"
          what="输入"
          shown={eye.shown}
          onToggle={eye.toggle}
        />
      )}
    </span>
  );
}

/**
 * 我的提交 (05 §3): a 代码判定红包's claimant looks back on what they typed
 * and what the code said, newest first, theirs only. The page keeps the
 * latest three; 全部 N 次 opens the rest. While it runs what was typed
 * hides behind one eye, as a 口令 does (05 §9).
 */
export function MyJudgments({
  activityId,
  ended,
}: {
  activityId: string;
  ended: boolean;
}) {
  const user = useSessionUser();
  const router = useRouter();
  const query = useMyJudgments(user?.id ?? "", activityId);
  const eye = useShown(activityId, ended);
  // Leaving the page hides them again (the dialog is over the page).
  const setShownFor = useSetAtom(shownAtom);
  useEffect(() => () => setShownFor(null), [setShownFor]);
  const first = query.data?.pages[0];
  if (!user || !first || first.total === 0) return null;
  return (
    <section className="grid gap-2" data-hb-part="my-judgments">
      <div className="flex min-h-9 items-center justify-between gap-3">
        <h2 className="text-sm font-medium text-ink-3">
          <RollingText text={`我的提交 · ${first.total} 次`} />
        </h2>
        <span className="-mr-2 flex items-center">
          <Privacy eye={eye} />
        </span>
      </div>
      <ul className="flex flex-col gap-1.5">
        <AnimatePresence initial={false}>
          {first.items.slice(0, ON_PAGE).map((item) => (
            <Row
              key={item.attempt}
              item={item}
              activityId={activityId}
              shown={eye.shown}
            />
          ))}
        </AnimatePresence>
      </ul>
      {first.total > ON_PAGE && (
        <Button
          id="judgments-all"
          variant="ghost"
          size="xs"
          aria-haspopup="dialog"
          className="gap-0.5 justify-self-center pr-1.5"
          onClick={() => switchOverlay(router, { panel: "judgments" })}
        >
          全部 {first.total} 次
          <ChevronRight aria-hidden="true" />
        </Button>
      )}
    </section>
  );
}

function JudgmentsBody({
  activityId,
  onClose,
}: {
  activityId: string;
  onClose: () => void;
}) {
  const user = useSessionUser();
  const page = useHongbaoPageData(activityId).data;
  const query = useMyJudgments(user?.id ?? "", activityId);
  const ended = page?.view.ended ?? false;
  const eye = useShown(activityId, ended);
  const list = useQueryLazyList({
    hasNextPage: query.hasNextPage,
    isFetchingNextPage: query.isFetchingNextPage,
    isFetchNextPageError: query.isFetchNextPageError,
    fetchNextPage: query.fetchNextPage,
    pageCount: query.data?.pages.length ?? 0,
  });
  const total = query.data?.pages[0]?.total ?? 0;
  const items = query.data?.pages.flatMap((batch) => batch.items) ?? [];
  const activity = page?.activity;
  return (
    <>
      <header className="grid gap-1 px-5 pt-4 pb-3">
        <div className="flex items-center justify-between gap-3">
          <h2 id="judgments-title" className="text-lg font-semibold text-ink">
            我的提交 · {total} 次
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
        </div>
        <div className="flex min-w-0 items-center justify-between gap-3">
          {activity && (
            <p className="flex min-w-0 items-center gap-1.5 text-sm text-ink-2">
              <Avatar
                name={activity.author.displayName}
                src={activity.author.avatarUrl}
                size={18}
              />
              <span className="truncate">
                {activity.author.displayName}的红包 · {activity.title}
              </span>
            </p>
          )}
          <span className="-my-1 -mr-2 flex items-center">
            <Privacy eye={eye} />
          </span>
        </div>
      </header>
      <div className="view-scroll relative min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 pb-5">
        <ul className="flex flex-col gap-1.5">
          <AnimatePresence initial={false}>
            {items.map((item) => (
              <Row
                key={item.attempt}
                item={item}
                activityId={activityId}
                shown={eye.shown}
              />
            ))}
          </AnimatePresence>
        </ul>
        <LazyListEnd list={list} done={`共 ${total} 次`} />
      </div>
    </>
  );
}

/** 我的提交 in full: every judged submission, twenty more as it scrolls. */
export function MyJudgmentsDialog() {
  return (
    <PanelDialog
      panel="judgments"
      triggerId="judgments-all"
      labelledBy="judgments-title"
      width="34rem"
    >
      {(activityId, close) => (
        <JudgmentsBody activityId={activityId} onClose={close} />
      )}
    </PanelDialog>
  );
}
