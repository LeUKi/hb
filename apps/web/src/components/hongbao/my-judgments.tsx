import type { JudgeFetchAnswer, JudgeNote, MyJudgment } from "@hb/contracts";
import { useRouter } from "@tanstack/react-router";
import { ChevronDown, ChevronRight, X } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useId, useState } from "react";
import { useMyJudgments } from "../../lib/judge";
import { ease, useReducedMotionPref } from "../../lib/motion";
import { switchOverlay } from "../../lib/overlay";
import { clockSeconds } from "../../lib/roster-time";
import { useSessionUser } from "../../lib/session";
import { LazyListEnd, useQueryLazyList } from "../page/lazy-list";
import { PanelDialog } from "../shell/panel-dialog";
import { Avatar } from "../ui/avatar";
import { Button } from "../ui/button";
import { RollingText } from "../ui/morph-label";
import { ListItem, Reveal } from "../ui/reveal";
import { Squircle } from "../ui/squircle";
import { useHongbaoPageData } from "./use-hongbao-data";

/** On the page; the rest are in the dialog (05 §3). */
const ON_PAGE = 3;

const notes: Record<JudgeNote, string> = {
  cap: "按上限发",
  floor: "按每份至少发",
  last: "最后一份，发完剩下的",
};

const failed: Record<NonNullable<JudgeFetchAnswer["error"]>, string> = {
  timeout: "超时",
  unreachable: "连不上",
  "too-big": "返回超过 64 KB",
};

/**
 * 联网 (docs/programmable-hongbao-design.md §9.4): once it is over, what
 * this judgment's requests got back — the site, the status, the body as
 * it came — folded until asked for. Never what was sent.
 */
function FetchAnswers({ answers }: { answers: JudgeFetchAnswer[] }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <div className="grid gap-1">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((current) => !current)}
        className="-ml-0.5 inline-flex items-center gap-0.5 justify-self-start text-xs text-ink-3 hover:text-ink-2"
      >
        联网返回 · {answers.length} 个
        <ChevronDown
          aria-hidden="true"
          className={`size-3.5 transition-transform ${open ? "rotate-180" : ""}`}
        />
      </button>
      <Reveal show={open}>
        <ul id={id} className="grid gap-1.5">
          {answers.map((answer, index) => (
            <li
              // In order; nothing else tells two answers of one site apart.
              // biome-ignore lint/suspicious/noArrayIndexKey: fixed list
              key={index}
              className="grid gap-0.5 rounded-lg bg-fill-2 px-2.5 py-1.5"
            >
              <span className="text-xs text-ink-3">
                {answer.host} ·{" "}
                {answer.error ? failed[answer.error] : answer.status}
              </span>
              {answer.response !== undefined && answer.response !== "" && (
                <pre className="max-h-48 overflow-auto font-mono text-xs break-all whitespace-pre-wrap text-ink-2">
                  {answer.response}
                </pre>
              )}
            </li>
          ))}
        </ul>
      </Reveal>
    </div>
  );
}

/**
 * One judged submission: 第 N 次 and when, what was typed (as typed: a
 * 代码判定红包's inputs are not hidden, 05 §3), the result, the reply, and
 * once it is over what its requests got back.
 */
export function JudgmentRow({ item }: { item: MyJudgment }) {
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
          <p className="font-mono text-base break-all whitespace-pre-wrap text-ink">
            {item.input}
          </p>
          {item.message && (
            <p className="text-sm text-ink-2">
              <span className="text-ink-3">代码的回复：</span>
              {item.message}
            </p>
          )}
          {item.note && (
            <p className="text-sm text-ink-2">{notes[item.note]}</p>
          )}
          {item.fetches && item.fetches.length > 0 && (
            <FetchAnswers answers={item.fetches} />
          )}
        </div>
      </Squircle>
    </ListItem>
  );
}

/** The sites of a 联网 红包's addresses: api.example.com、b.example.com. */
const hostsOf = (network: string[]) =>
  [...new Set(network.map((address) => new URL(address).hostname))].join("、");

/** What a screen reader hears of a judgment as it comes in. */
const spoken = (item: MyJudgment) =>
  `第 ${item.attempt} 次：${item.amount ? `领到 ${item.amount} LDC` : "没领到"}${
    item.message ? `。代码的回复：${item.message}` : ""
  }`;

/**
 * Under the 指令框 in a 代码判定红包's scope (02 §4): the latest judged
 * submission as a card — 第 N 次, what was typed, the result, the code's
 * reply in larger type — then the earlier ones, all of them as one
 * scrolls. Before the first, what taking part makes public.
 */
export function JudgmentRecord({ activityId }: { activityId: string }) {
  const user = useSessionUser();
  const reduced = useReducedMotionPref();
  const query = useMyJudgments(user?.id ?? "", activityId);
  const list = useQueryLazyList({
    hasNextPage: query.hasNextPage,
    isFetchingNextPage: query.isFetchingNextPage,
    isFetchNextPageError: query.isFetchNextPageError,
    fetchNextPage: query.fetchNextPage,
    pageCount: query.data?.pages.length ?? 0,
  });
  const network = useHongbaoPageData(activityId).data?.activity.judge?.network;
  const total = query.data?.pages[0]?.total ?? 0;
  const [latest, ...earlier] =
    query.data?.pages.flatMap((batch) => batch.items) ?? [];
  if (!user || !query.data) return null;
  if (!latest)
    return (
      <p className="px-2.5 pb-2 text-xs text-ink-3">
        提交后，你的昵称和判定次数会出现在参与名单里。
        {network &&
          `这个红包会联网：你的提交（数字 ID、用户名、等级和输入）可能被发到 ${hostsOf(network)}。`}
      </p>
    );
  return (
    <section aria-label="我的提交" className="grid gap-1.5 px-0.5 pb-1">
      <p role="status" className="sr-only">
        {spoken(latest)}
      </p>
      <AnimatePresence initial={false} mode="popLayout">
        <motion.div
          key={latest.attempt}
          initial={{ opacity: 0, y: reduced ? 0 : -8 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0 }}
          transition={{ duration: reduced ? 0 : 0.22, ease }}
        >
          <Squircle radius={14}>
            <div
              className={`grid gap-1.5 px-4 py-3 ${
                latest.amount ? "bg-success-soft" : "bg-fill-2"
              }`}
            >
              <div className="flex items-baseline justify-between gap-3">
                <span className="text-xs text-ink-3 tabular-nums">
                  第 {latest.attempt} 次 · {clockSeconds(Date.parse(latest.at))}
                </span>
                {latest.amount ? (
                  <span className="shrink-0 text-sm font-medium text-success tabular-nums">
                    领到 {latest.amount} LDC
                  </span>
                ) : (
                  <span className="shrink-0 text-sm text-ink-2">没领到</span>
                )}
              </div>
              <p className="font-mono text-sm break-all whitespace-pre-wrap text-ink-2">
                {latest.input}
              </p>
              <p className="text-lg leading-snug font-medium text-ink">
                {latest.message ?? "代码没有回复。"}
              </p>
              {latest.note && (
                <p className="text-sm text-ink-2">{notes[latest.note]}</p>
              )}
            </div>
          </Squircle>
        </motion.div>
      </AnimatePresence>
      <ul className="flex flex-col gap-1.5">
        <AnimatePresence initial={false}>
          {earlier.map((item) => (
            <JudgmentRow key={item.attempt} item={item} />
          ))}
        </AnimatePresence>
      </ul>
      <LazyListEnd
        list={list}
        done={`共 ${total} 次`}
        className="px-2 pt-0.5 text-xs"
      />
    </section>
  );
}

/** “仅你可见”, beside the title on the page and in the dialog. */
function Privacy() {
  return <span className="shrink-0 text-xs text-ink-3">仅你可见</span>;
}

/**
 * 我的提交 (05 §3): a 代码判定红包's claimant looks back on what they typed
 * and what the code said, newest first, theirs only. The page keeps the
 * latest three; 全部 N 次 opens the rest. What was typed shows as typed
 * (2026-10-25: to look back on it; a 口令 still hides, 05 §9).
 */
export function MyJudgments({ activityId }: { activityId: string }) {
  const user = useSessionUser();
  const router = useRouter();
  const query = useMyJudgments(user?.id ?? "", activityId);
  const first = query.data?.pages[0];
  if (!user || !first || first.total === 0) return null;
  return (
    <section className="grid gap-2" data-hb-part="my-judgments">
      <div className="flex min-h-9 items-center justify-between gap-3">
        <h2 className="text-sm font-medium text-ink-3">
          <RollingText text={`我的提交 · ${first.total} 次`} />
        </h2>
        <span className="-mr-2 flex items-center">
          <Privacy />
        </span>
      </div>
      <ul className="flex flex-col gap-1.5">
        <AnimatePresence initial={false}>
          {first.items.slice(0, ON_PAGE).map((item) => (
            <JudgmentRow key={item.attempt} item={item} />
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
            <Privacy />
          </span>
        </div>
      </header>
      <div className="view-scroll relative min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 pb-5">
        <ul className="flex flex-col gap-1.5">
          <AnimatePresence initial={false}>
            {items.map((item) => (
              <JudgmentRow key={item.attempt} item={item} />
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
