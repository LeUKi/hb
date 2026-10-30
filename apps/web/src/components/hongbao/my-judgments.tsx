import type { JudgeFetchAnswer, JudgeNote, MyJudgment } from "@hb/contracts";
import { useRouter } from "@tanstack/react-router";
import { useAtomValue } from "jotai";
import { ChevronDown, ChevronRight, X } from "lucide-react";
import { AnimatePresence } from "motion/react";
import { type ReactNode, useEffect, useId, useState } from "react";
import { cn } from "../../lib/cn";
import { moveLabel, useMyJudgments } from "../../lib/judge";
import { switchOverlay } from "../../lib/overlay";
import { clockSeconds } from "../../lib/roster-time";
import { useSessionUser } from "../../lib/session";
import { judgingAtom } from "../omnibox/state";
import { LazyListEnd, useQueryLazyList } from "../page/lazy-list";
import { PanelDialog } from "../shell/panel-dialog";
import { Avatar } from "../ui/avatar";
import { Button } from "../ui/button";
import { MorphLabel, RollingText } from "../ui/morph-label";
import { ListItem, Reveal, Swap } from "../ui/reveal";
import { Squircle } from "../ui/squircle";
import { type BoardActivity, useJudgeBoard } from "./judge-board";
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
 * One judged submission, laid out one way wherever it shows (judge-page
 * §11.3): 第 N 次 and when, the result on the right; the code's reply; what
 * was typed, small and in fixed width (as typed: a 代码判定红包's inputs are
 * not hidden, 05 §3); once it is over, what its requests got back. The
 * 指令框's newest (`latest`) differs only in its ground. On its way
 * (`pending`) it says 正在判定… under the gold sheen and turns into its
 * result in place; `after` hangs under it (还在判定…).
 */
/**
 * What one judgment came to, on its right: protocol 5's move (docs/multi-
 * prize-design.md §4.1) — “+0.50 · 待结算 1.20 LDC”, in a list “+0.50 →
 * 1.20”, or what it settled with — or else 领到 or 没领到.
 */
function resultOf(item: MyJudgment, short = false) {
  if (!item.moved) return item.amount ? `领到 ${item.amount} LDC` : "没领到";
  return moveLabel(item.moved, item.amount, !short);
}

/** 第 N 次, or (protocol 5) whose judgment it was that moved them. */
const whoseOf = (item: MyJudgment) =>
  item.by ? `${item.by.name}的第 ${item.attempt} 次` : `第 ${item.attempt} 次`;

/** One key from 正在判定… to its result: the same row turns. */
const keyOf = (item: MyJudgment) =>
  item.by ? `${item.at} ${item.by.name} ${item.attempt}` : String(item.attempt);

export function JudgmentRow({
  item,
  latest = false,
  pending = false,
  after,
}: {
  item: MyJudgment;
  latest?: boolean;
  pending?: boolean;
  after?: ReactNode;
}) {
  const won = Boolean(item.amount);
  const label = `${whoseOf(item)} · ${clockSeconds(Date.parse(item.at))}`;
  const result = pending ? "正在判定…" : resultOf(item, !latest);
  return (
    <ListItem className="flex flex-col gap-1.5">
      <Squircle radius={12}>
        <div
          className={cn(
            "grid gap-0.5 px-3.5 py-2.5 transition-colors duration-300",
            !latest ? "bg-fill" : won ? "bg-success-soft" : "bg-fill-2",
            pending && "loading-sheen loading-sheen-gold",
          )}
        >
          <div className="flex items-baseline justify-between gap-3">
            <span className="text-xs text-ink-3 tabular-nums">
              {/* The press's time, then the judgment's: its digits roll. */}
              {latest ? <RollingText text={label} /> : label}
            </span>
            <span
              className={cn(
                "shrink-0 text-sm tabular-nums",
                won ? "font-medium text-success" : "text-ink-3",
              )}
            >
              {latest ? (
                <MorphLabel align="start">{result}</MorphLabel>
              ) : (
                result
              )}
            </span>
          </div>
          <Reveal show={!pending && Boolean(item.message)}>
            <p className="text-base leading-snug break-words text-ink">
              {item.message}
            </p>
          </Reveal>
          {item.note && (
            <p className="text-sm text-ink-2">{notes[item.note]}</p>
          )}
          {item.input !== undefined && (
            <p className="font-mono text-xs break-all whitespace-pre-wrap text-ink-3">
              {item.input}
            </p>
          )}
          {item.fetches && item.fetches.length > 0 && (
            <FetchAnswers answers={item.fetches} />
          )}
        </div>
      </Squircle>
      {after}
    </ListItem>
  );
}

/** The sites of a 联网 红包's addresses: api.example.com、b.example.com. */
const hostsOf = (network: string[]) =>
  [...new Set(network.map((address) => new URL(address).hostname))].join("、");

/** What a screen reader hears of a judgment as it comes in. */
const spoken = (item: MyJudgment) =>
  `${whoseOf(item)}：${resultOf(item)}${
    item.message ? `。判定器的回复：${item.message}` : ""
  }`;

/**
 * 判定中 for 2 s (`since` the press, null once answered): why it is taking
 * longer, under its card (02 §4), folding away with the answer.
 */
function StillJudging({
  since,
  network,
}: {
  since: number | null;
  network: boolean;
}) {
  const [late, setLate] = useState(false);
  useEffect(() => {
    setLate(false);
    if (since === null) return;
    const timer = window.setTimeout(() => setLate(true), 2000);
    return () => window.clearTimeout(timer);
  }, [since]);
  return (
    <Reveal show={since !== null && late}>
      <p className="px-2.5 text-xs text-ink-3">
        {network ? "判定器在联网，最多等 5 秒" : "还在判定…"}
      </p>
    </Reveal>
  );
}

/**
 * 红包状态 in the 指令框 (judge-page §11.3): the code's sentence, as on the
 * 红包 page, and the latest line in 动态 under it; nothing without either.
 */
function JudgeState({ activity }: { activity: BoardActivity }) {
  const { view, lines } = useJudgeBoard(activity);
  const summary = view?.summary;
  const line = lines[0];
  if (!summary && !line) return null;
  return (
    <section aria-label="红包状态">
      <Squircle radius={12}>
        <div className="grid gap-0.5 bg-fill-2 px-3.5 py-2.5">
          <h3 className="text-xs font-medium text-ink-3">红包状态</h3>
          {summary && (
            <Swap id={summary}>
              <p className="text-base leading-snug break-words text-ink">
                {summary}
              </p>
            </Swap>
          )}
          {line && (
            <Swap id={String(line.n)}>
              <p className="truncate text-sm text-ink-2">
                @{line.user.displayName}：{line.text}
              </p>
            </Swap>
          )}
        </div>
      </Squircle>
    </section>
  );
}

/**
 * Under the 指令框 in a 代码判定红包's scope (02 §4, judge-page §11.3):
 * 红包状态, then 我的记录 · N 条, every submission in one way, the newest
 * on top, all of them as one scrolls. Before the first, what taking part
 * makes public. A submission on its way is the top row already (正在判定…,
 * the gold sheen sweeping it) and turns into its result in place.
 */
export function JudgmentRecord({ activityId }: { activityId: string }) {
  const user = useSessionUser();
  const query = useMyJudgments(user?.id ?? "", activityId);
  const list = useQueryLazyList({
    hasNextPage: query.hasNextPage,
    isFetchingNextPage: query.isFetchingNextPage,
    isFetchNextPageError: query.isFetchNextPageError,
    fetchNextPage: query.fetchNextPage,
    pageCount: query.data?.pages.length ?? 0,
  });
  const activity = useHongbaoPageData(activityId).data?.activity;
  const network = activity?.judge?.network;
  const judging = useAtomValue(judgingAtom);
  const total = query.data?.pages[0]?.total ?? 0;
  const attempts = query.data?.pages[0]?.attempts ?? 0;
  const items = query.data?.pages.flatMap((batch) => batch.items) ?? [];
  if (!user || !query.data) return null;
  const pending = judging?.activityId === activityId ? judging : null;
  // On its way, it heads the record as the next one.
  const rows: MyJudgment[] = pending
    ? [
        {
          attempt: attempts + 1,
          at: new Date(pending.at).toISOString(),
          input: pending.input,
        },
        ...items,
      ]
    : items;
  const latest = items[0];
  return (
    <div className="flex flex-col gap-3 px-0.5 pb-1">
      {activity && <JudgeState activity={activity} />}
      {rows.length === 0 ? (
        <p className="px-2.5 pb-1 text-xs text-ink-3">
          提交后，你的昵称和判定次数会出现在参与名单里。
          {network &&
            `这个红包会联网：你的提交（数字 ID、用户名、等级和输入）可能被发到 ${hostsOf(network)}。`}
        </p>
      ) : (
        <section aria-label="我的记录" className="flex flex-col gap-1.5">
          <p role="status" className="sr-only">
            {pending ? "正在判定…" : latest ? spoken(latest) : ""}
          </p>
          <h3 className="px-2.5 text-xs font-medium text-ink-3">
            <RollingText text={`我的记录 · ${total} 条`} />
          </h3>
          <ul className="flex flex-col gap-1.5">
            <AnimatePresence initial={false}>
              {rows.map((item, index) => (
                <JudgmentRow
                  key={keyOf(item)}
                  item={item}
                  latest={index === 0}
                  pending={pending !== null && index === 0}
                  after={
                    index === 0 ? (
                      <StillJudging
                        since={pending?.at ?? null}
                        network={Boolean(network)}
                      />
                    ) : undefined
                  }
                />
              ))}
            </AnimatePresence>
          </ul>
          <LazyListEnd
            list={list}
            done={`共 ${total} 条`}
            className="px-2 pt-0.5 text-xs"
          />
        </section>
      )}
    </div>
  );
}

/**
 * Who sees these, beside the title on the page and in the dialog: the
 * sender too, in 判定记录 (docs/judge-records-design.md §3).
 */
function Privacy() {
  return (
    <span className="shrink-0 text-xs text-ink-3">你和红包作者看得到</span>
  );
}

/**
 * 我的记录 (05 §3; multi-prize §4.1): a 代码判定红包's claimant looks back on
 * what they typed and what the code said, and others' judgments that moved
 * them, newest first, theirs only. The page keeps the latest three; 全部 N
 * 条 opens the rest. What was typed shows as typed
 * (2026-10-25: to look back on it; a 口令 still hides, 05 §9).
 */
export function MyJudgments({ activityId }: { activityId: string }) {
  const user = useSessionUser();
  const router = useRouter();
  const query = useMyJudgments(user?.id ?? "", activityId);
  const judging = useAtomValue(judgingAtom);
  const first = query.data?.pages[0];
  const pending = judging?.activityId === activityId ? judging : null;
  if (!user || !first || (first.total === 0 && !pending)) return null;
  // On its way (from the box, or the 附带网页 with the box closed, judge-
  // page §11.3): on top already, as in the box's record.
  const rows: MyJudgment[] = pending
    ? [
        {
          attempt: first.attempts + 1,
          at: new Date(pending.at).toISOString(),
          input: pending.input,
        },
        ...first.items,
      ]
    : first.items;
  return (
    <section className="grid gap-2" data-hb-part="my-judgments">
      <div className="flex min-h-9 items-center justify-between gap-3">
        <h2 className="text-sm font-medium text-ink-3">
          <RollingText text={`我的记录 · ${first.total} 条`} />
        </h2>
        <span className="-mr-2 flex items-center">
          <Privacy />
        </span>
      </div>
      <ul className="flex flex-col gap-1.5">
        <AnimatePresence initial={false}>
          {rows.slice(0, ON_PAGE).map((item, index) => (
            <JudgmentRow
              key={keyOf(item)}
              item={item}
              pending={pending !== null && index === 0}
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
          全部 {first.total} 条
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
            我的记录 · {total} 条
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
              <JudgmentRow key={keyOf(item)} item={item} />
            ))}
          </AnimatePresence>
        </ul>
        <LazyListEnd list={list} done={`共 ${total} 条`} />
      </div>
    </>
  );
}

/** 我的记录 in full: every judged submission, twenty more as it scrolls. */
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
