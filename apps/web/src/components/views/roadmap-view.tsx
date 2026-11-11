import {
  ROADMAP_LIMITS,
  type RoadmapItem,
  type RoadmapList,
} from "@hb/contracts";
import type { UseInfiniteQueryResult } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { ChevronRight, ThumbsUp, X } from "lucide-react";
import { type ReactNode, useEffect, useId, useState } from "react";
import { refused } from "../../lib/activities";
import { cn } from "../../lib/cn";
import {
  type RoadmapSort,
  useRoadmapDelete,
  useRoadmapDetail,
  useRoadmapList,
  useRoadmapRequest,
  useRoadmapSimilar,
  useRoadmapSummary,
  useRoadmapVote,
} from "../../lib/roadmap";
import { agoLabel, fullTime } from "../../lib/roster-time";
import { useIdentity } from "../../lib/session";
import { counter } from "../hongbao-form/fields";
import { dayLabel } from "../judges/judge-bits";
import { useOmniboxController } from "../omnibox/use-omnibox-controller";
import {
  type LazyList,
  LazyListEnd,
  useQueryLazyList,
} from "../page/lazy-list";
import { EmptyNote, Page, PageHeader, PageSection, Panel } from "../page/page";
import { PageLoad, queryLoad, ResultLoad, resultOf } from "../page/page-state";
import { ConfirmDialog } from "../shell/confirm-dialog";
import { useSearchChoice } from "../shell/use-search-choice";
import { WindowDialog } from "../shell/window-dialog";
import { Button } from "../ui/button";
import { Field, Segmented, TextArea, TextInput } from "../ui/field";
import { Reveal, Swap } from "../ui/reveal";
import { radius, Squircle } from "../ui/squircle";
import { DetailPart, useSettled } from "./admin/admin-frame";

// 施工中 /roadmap (docs/roadmap-design.md): what the 站长 is building, in
// the site's gold; what is done, folded; what people asked for, with
// their votes; and asking for one. The 站长's own tools are in 网站管理.

const DAY = 86_400_000;

/** 开工 12 天 (today: 今天开工). */
function startedLabel(at: string | null) {
  if (!at) return "";
  const days = Math.floor((Date.now() - Date.parse(at)) / DAY);
  return days < 1 ? "今天开工" : `开工 ${days} 天`;
}

/** 3 天前 (§2.3): agoLabel's words for a day, then days, then the date. */
function sinceLabel(at: string) {
  const time = Date.parse(at);
  const days = Math.floor((Date.now() - time) / DAY);
  if (days < 1) return agoLabel(time);
  return days < 30 ? `${days} 天前` : dayLabel(time);
}

/** Whose: “@小明 提的”, nothing for the 站长's own. */
const askedBy = (item: RoadmapItem) =>
  item.byOwner ? "" : `@${item.author.username} 提的`;

/** Only the count: for those done or declined. */
function VoteCount({
  votes,
  className,
}: {
  votes: number;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1 text-xs text-ink-3 tabular-nums",
        className,
      )}
    >
      <ThumbsUp className="size-3.5" aria-hidden="true" />
      <span className="sr-only">赞</span>
      {votes}
    </span>
  );
}

/**
 * 点赞 (§2.4): its count beside the thumb; given, in the accent. Those done
 * or declined only show the count.
 */
function VoteButton({
  item,
  onGuest,
}: {
  item: RoadmapItem;
  onGuest: () => void;
}) {
  const { user } = useIdentity();
  const vote = useRoadmapVote();
  const [failed, setFailed] = useState(false);
  if (item.status !== "request" && item.status !== "building")
    return <VoteCount votes={item.votes} />;
  return (
    <span className="flex shrink-0 flex-col items-end gap-1">
      <Squircle radius={9}>
        <button
          type="button"
          aria-pressed={item.voted}
          aria-label={`点赞，现在 ${item.votes} 个`}
          onClick={(event) => {
            event.stopPropagation();
            if (!user) return onGuest();
            setFailed(false);
            vote.mutate(
              { id: item.id, voted: !item.voted },
              { onError: () => setFailed(true) },
            );
          }}
          className={cn(
            "inline-flex h-[30px] items-center gap-1.5 px-2.5 text-sm font-semibold tabular-nums transition-colors",
            item.voted
              ? "bg-accent-soft text-accent-ink"
              : "bg-fill-2 text-ink hover:bg-[rgb(42_21_25/0.12)]",
          )}
        >
          <ThumbsUp
            className="size-[15px]"
            fill={item.voted ? "currentColor" : "none"}
            aria-hidden="true"
          />
          {item.votes}
        </button>
      </Squircle>
      <Reveal show={failed}>
        <span role="alert" className="text-xs text-danger">
          点赞没成功，再试一次。
        </span>
      </Reveal>
    </span>
  );
}

/** 正在施工 (§2.1): the site's gold, its sheen sweeping slow. */
function BuildingCard({
  item,
  onOpen,
  onGuest,
}: {
  item: RoadmapItem;
  onOpen: () => void;
  onGuest: () => void;
}) {
  return (
    <Squircle radius={radius.card}>
      {/* The whole card opens it; its title is the button to reach it. */}
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: the title is the keyboard's way */}
      <article
        onClick={onOpen}
        className="loading-sheen loading-sheen-gold grid h-full cursor-pointer content-start gap-2.5 bg-gold-soft p-4 [&::after]:[animation-duration:3s]"
      >
        <span className="w-fit">
          <Squircle radius={7}>
            <span className="inline-flex h-[22px] items-center bg-gold-soft-strong px-2 text-xs font-semibold text-gold-ink">
              施工中
            </span>
          </Squircle>
        </span>
        <h3 className="text-lg font-semibold text-ink">
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              onOpen();
            }}
            className="text-left hover:underline"
          >
            {item.title}
          </button>
        </h3>
        {item.detail && (
          <p className="line-clamp-2 text-sm text-ink-2">{item.detail}</p>
        )}
        {item.note && (
          <p className="text-sm text-ink">
            “{item.note.text}”
            <span className="ml-1 text-xs text-ink-3">
              {agoLabel(Date.parse(item.note.at))}
            </span>
          </p>
        )}
        <div className="mt-auto flex items-end justify-between gap-2 pt-1 text-xs text-ink-2">
          <span>
            {[startedLabel(item.startedAt), askedBy(item)]
              .filter(Boolean)
              .join(" · ")}
          </span>
          <VoteButton item={item} onGuest={onGuest} />
        </div>
      </article>
    </Squircle>
  );
}

/** 功能请求 (§2.3): a panel card, smaller than the gold. */
function RequestCard({
  item,
  onOpen,
  onGuest,
}: {
  item: RoadmapItem;
  onOpen: () => void;
  onGuest: () => void;
}) {
  return (
    <Panel className="h-full">
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: the title is the keyboard's way */}
      <article
        onClick={onOpen}
        className="grid h-full cursor-pointer content-start gap-1.5 p-3.5"
      >
        <h3 className="text-base font-semibold text-ink">
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              onOpen();
            }}
            className="text-left hover:underline"
          >
            {item.title}
          </button>
        </h3>
        {item.detail && (
          <p className="line-clamp-2 text-sm text-ink-2">{item.detail}</p>
        )}
        <div className="mt-auto flex items-end justify-between gap-2 pt-1 text-xs text-ink-3">
          <span title={fullTime(Date.parse(item.createdAt))}>
            {item.byOwner ? "站长" : `@${item.author.username}`} ·{" "}
            {sinceLabel(item.createdAt)}
          </span>
          <VoteButton item={item} onGuest={onGuest} />
        </div>
      </article>
    </Panel>
  );
}

/** Two a line on a wide window, one on a phone. */
function Cards({ children }: { children: ReactNode }) {
  return (
    <div className="@container/cards">
      <div className="grid gap-3 @min-[34rem]/cards:grid-cols-2">
        {children}
      </div>
    </div>
  );
}

function listOf(query: UseInfiniteQueryResult<{ pages: RoadmapList[] }>) {
  return {
    items: query.data?.pages.flatMap((page) => page.items) ?? [],
    lazy: {
      hasNextPage: query.hasNextPage,
      isFetchingNextPage: query.isFetchingNextPage,
      isFetchNextPageError: query.isFetchNextPageError,
      fetchNextPage: query.fetchNextPage,
      pageCount: query.data?.pages.length ?? 0,
      isPlaceholderData: query.isPlaceholderData,
    },
  };
}

/** The end of a list: “共 N 件” once the count is known. */
const endOf = (total: number | undefined) =>
  total === undefined ? "已全部加载" : `共 ${total} 件`;

/**
 * “已完成 N 件 ›”, “不做的 N 件 ›” (§2.2, §2.3): a quiet link-like button
 * that opens the list in a dialog (as 🐟额's 已停用的密钥).
 */
function FoldedButton({
  label,
  onOpen,
}: {
  label: string;
  onOpen: () => void;
}) {
  return (
    <Button
      variant="quiet"
      size="xs"
      aria-haspopup="dialog"
      className="gap-0.5 justify-self-center pr-1.5"
      onClick={onOpen}
    >
      {label}
      <ChevronRight aria-hidden="true" />
    </Button>
  );
}

/** 已完成 or 不做的, in a dialog: its list read as it scrolls. */
function FoldedDialog({
  open,
  title,
  onClose,
  children,
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const titleId = useId();
  return (
    <WindowDialog
      open={open}
      onClose={onClose}
      labelledBy={titleId}
      width="34rem"
    >
      <header className="flex items-center justify-between gap-3 px-5 pt-4 pb-2">
        <h2 id={titleId} className="text-lg font-semibold text-ink">
          {title}
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
      <div className="view-scroll min-h-0 flex-1 overflow-y-auto overscroll-contain px-3.5 pb-4">
        {children}
      </div>
    </WindowDialog>
  );
}

/** A row in a folded list: the whole row opens it. */
function FoldedRow({
  onOpen,
  className,
  children,
}: {
  onOpen: () => void;
  className: string;
  children: ReactNode;
}) {
  return (
    <li>
      <Squircle radius={radius.row}>
        <button
          type="button"
          aria-haspopup="dialog"
          onClick={onOpen}
          className={cn(
            "grid w-full items-start gap-3 px-3 py-3 text-left transition-colors hover:bg-fill-2",
            className,
          )}
        >
          {children}
        </button>
      </Squircle>
    </li>
  );
}

/** 已完成 (§2.2): a line each, the newest first, with its date. */
function DoneList({
  total,
  onOpen,
}: {
  total: number | undefined;
  onOpen: (id: string) => void;
}) {
  const query = useRoadmapList("done", "new");
  const { items, lazy } = listOf(query);
  const list = useQueryLazyList(lazy);
  return (
    <ResultLoad id="done" load={resultOf(query)}>
      <ul
        className="flex flex-col gap-0.5"
        aria-busy={list.state === "loading" || undefined}
      >
        {items.map((item) => (
          <FoldedRow
            key={item.id}
            onOpen={() => onOpen(item.id)}
            className="grid-cols-[4.5rem_minmax(0,1fr)_auto]"
          >
            <span className="pt-0.5 text-xs text-ink-3 tabular-nums">
              {item.doneAt ? dayLabel(Date.parse(item.doneAt)) : ""}
            </span>
            <span className="grid min-w-0 gap-0.5">
              <span className="text-base font-medium text-ink">
                {item.title}
              </span>
              {item.detail && (
                <span className="line-clamp-1 text-sm text-ink-2">
                  {item.detail}
                </span>
              )}
            </span>
            <VoteCount votes={item.votes} className="pt-0.5" />
          </FoldedRow>
        ))}
      </ul>
      <LazyListEnd list={list} done={endOf(total)} />
    </ResultLoad>
  );
}

/** 不做的 (§2.3): a line each, with why not. */
function DeclinedList({
  total,
  onOpen,
}: {
  total: number | undefined;
  onOpen: (id: string) => void;
}) {
  const query = useRoadmapList("declined", "new");
  const { items, lazy } = listOf(query);
  const list = useQueryLazyList(lazy);
  return (
    <ResultLoad id="declined" load={resultOf(query)}>
      <ul
        className="flex flex-col gap-0.5"
        aria-busy={list.state === "loading" || undefined}
      >
        {items.map((item) => (
          <FoldedRow
            key={item.id}
            onOpen={() => onOpen(item.id)}
            className="grid-cols-[minmax(0,1fr)_auto]"
          >
            <span className="grid min-w-0 gap-0.5">
              <span className="text-base font-medium text-ink">
                {item.title}
              </span>
              {item.reason && (
                <span className="text-sm text-ink-2">不做：{item.reason}</span>
              )}
              <span
                className="text-xs text-ink-3"
                title={fullTime(Date.parse(item.createdAt))}
              >
                {item.byOwner ? "站长" : `@${item.author.username}`} ·{" "}
                {sinceLabel(item.createdAt)}
              </span>
            </span>
            <VoteCount votes={item.votes} className="pt-0.5" />
          </FoldedRow>
        ))}
      </ul>
      <LazyListEnd list={list} done={endOf(total)} />
    </ResultLoad>
  );
}

function RequestGrid({
  query,
  list,
  items,
  total,
  onOpen,
  onGuest,
  empty,
}: {
  query: Parameters<typeof resultOf>[0];
  list: LazyList;
  items: RoadmapItem[];
  total: number | undefined;
  onOpen: (id: string) => void;
  onGuest: () => void;
  empty: ReactNode;
}) {
  return (
    <ResultLoad id="requests" load={resultOf(query)}>
      {items.length === 0 ? (
        empty
      ) : (
        <div className="grid gap-3">
          <Cards>
            {items.map((item) => (
              <RequestCard
                key={item.id}
                item={item}
                onOpen={() => onOpen(item.id)}
                onGuest={onGuest}
              />
            ))}
          </Cards>
          <LazyListEnd list={list} done={endOf(total)} />
        </div>
      )}
    </ResultLoad>
  );
}

/**
 * 提一个需求 (§3), and changing one's own: 想要什么, 说明, and the like of
 * it already asked for as it is typed.
 */
function RequestDialog({
  open,
  editing,
  onClose,
  onDone,
  onOpen,
  onGuest,
}: {
  open: boolean;
  editing: RoadmapItem | null;
  onClose: () => void;
  onDone: (item: RoadmapItem) => void;
  onOpen: (id: string) => void;
  onGuest: () => void;
}) {
  const titleId = useId();
  const [title, setTitle] = useState("");
  const [detail, setDetail] = useState("");
  const [error, setError] = useState<string | null>(null);
  const save = useRoadmapRequest();
  // Each opening starts from what it changes, or empty.
  useEffect(() => {
    if (!open) return;
    setTitle(editing?.title ?? "");
    setDetail(editing?.detail ?? "");
    setError(null);
  }, [open, editing]);
  // Asked once typing pauses, not at every key; nothing while closed, so a
  // new opening does not show the last one's.
  const typed = useSettled(open && !editing ? title.trim() : "");
  const similar = useRoadmapSimilar(typed);
  const like =
    Array.from(typed).length >= 2
      ? (similar.data?.items ?? []).filter((item) => item.id !== editing?.id)
      : [];
  const tooLong =
    Array.from(title.trim()).length > ROADMAP_LIMITS.title ||
    Array.from(detail.trim()).length > ROADMAP_LIMITS.detail;
  const submit = () => {
    if (save.isPending) return;
    if (!title.trim()) return setError("写一下想要什么");
    if (tooLong) return;
    setError(null);
    save.mutate(
      {
        title: title.trim(),
        detail: detail.trim(),
        ...(editing ? { id: editing.id } : {}),
      },
      {
        onSuccess: ({ item }) => onDone(item),
        onError: (failure) =>
          setError(
            refused(failure)
              ? failure.message
              : "提交没有完成：网络或服务出了问题。可以再试一次。",
          ),
      },
    );
  };
  return (
    <WindowDialog
      open={open}
      onClose={onClose}
      labelledBy={titleId}
      busy={save.isPending}
      width="32rem"
    >
      <form
        className="flex flex-col gap-4 p-5"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <h2 id={titleId} className="text-lg font-semibold text-ink">
          {editing ? "改这个需求" : "提一个需求"}
        </h2>
        <Field
          label="想要什么"
          htmlFor="roadmap-title"
          aside={counter(title.trim(), ROADMAP_LIMITS.title)}
        >
          <TextInput
            id="roadmap-title"
            value={title}
            placeholder="比如：红包记录能按金额排序"
            autoComplete="off"
            onChange={(event) => setTitle(event.target.value)}
          />
        </Field>
        <Reveal show={like.length > 0}>
          <div className="grid gap-2">
            <p className="px-1 text-xs text-ink-3">可能有人提过了</p>
            <Panel className="grid gap-0.5 p-1.5">
              {like.map((item) => (
                <div
                  key={item.id}
                  className="flex items-center justify-between gap-3 px-2.5 py-2"
                >
                  <button
                    type="button"
                    onClick={() => onOpen(item.id)}
                    className="min-w-0 truncate text-left text-sm text-ink hover:underline"
                  >
                    {item.status === "building" ? "施工中 · " : ""}
                    {item.title}
                  </button>
                  <VoteButton item={item} onGuest={onGuest} />
                </div>
              ))}
            </Panel>
            <p className="px-1 text-xs text-ink-3">
              如果是同一件事，给它点个赞就行，不用再提。
            </p>
          </div>
        </Reveal>
        <Field
          label="说明"
          optional
          htmlFor="roadmap-detail"
          aside={counter(detail.trim(), ROADMAP_LIMITS.detail)}
        >
          <TextArea
            id="roadmap-detail"
            value={detail}
            rows={4}
            placeholder="为什么想要、怎么用"
            onChange={(event) => setDetail(event.target.value)}
          />
        </Field>
        <Reveal show={Boolean(error)}>
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        </Reveal>
        <div className="flex justify-end gap-2">
          <Button onClick={onClose} aria-disabled={save.isPending || undefined}>
            取消
          </Button>
          <Button
            type="submit"
            variant="primary"
            aria-disabled={save.isPending || tooLong || undefined}
          >
            {save.isPending ? "正在提交…" : editing ? "保存" : "提交"}
          </Button>
        </div>
      </form>
    </WindowDialog>
  );
}

/** One, opened (§2.5): its whole, its lines, and one's own to change. */
function ItemDialog({
  id,
  onClose,
  onEdit,
  onGuest,
}: {
  id: string | null;
  onClose: () => void;
  /** 改 one's own (none from 已完成 and 不做的: nothing there to change). */
  onEdit?: (item: RoadmapItem) => void;
  onGuest: () => void;
}) {
  const titleId = useId();
  // Kept while it closes.
  const [shown, setShown] = useState(id);
  if (id && id !== shown) setShown(id);
  const detail = useRoadmapDetail(shown);
  const remove = useRoadmapDelete();
  const [asking, setAsking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const item = detail.data?.item;
  return (
    <WindowDialog
      open={id !== null}
      onClose={onClose}
      labelledBy={titleId}
      width="34rem"
    >
      <div className="flex max-h-[min(44rem,85dvh)] flex-col">
        <header className="flex items-start justify-between gap-3 px-5 pt-4 pb-2">
          <h2 id={titleId} className="text-lg font-semibold text-ink">
            {item?.title ?? "施工中"}
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
        </header>
        <div className="view-scroll min-h-0 flex-1 overflow-y-auto px-5 pb-5">
          <Swap id={item ? item.id : detail.isError ? "failed" : "loading"}>
            <DetailPart query={detail} lines={3}>
              {({ item, notes }) => (
                <div className="grid gap-3">
                  {item.detail && (
                    <p className="text-sm whitespace-pre-wrap text-ink">
                      {item.detail}
                    </p>
                  )}
                  <p className="text-sm text-ink-2">
                    {[
                      item.byOwner ? "站长写的" : askedBy(item),
                      sinceLabel(item.createdAt),
                      item.status === "building" &&
                        startedLabel(item.startedAt),
                      item.status === "done" &&
                        item.doneAt &&
                        `${dayLabel(Date.parse(item.doneAt))}完成`,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </p>
                  {item.reason && (
                    <p className="text-sm text-ink">不做：{item.reason}</p>
                  )}
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <VoteButton item={item} onGuest={onGuest} />
                    {item.mine && item.status === "request" && (
                      <span className="flex gap-2">
                        <Button
                          variant="quiet"
                          size="sm"
                          onClick={() => onEdit?.(item)}
                        >
                          改
                        </Button>
                        <Button
                          variant="quiet"
                          size="sm"
                          aria-haspopup="dialog"
                          onClick={() => {
                            setError(null);
                            setAsking(true);
                          }}
                        >
                          删掉
                        </Button>
                      </span>
                    )}
                  </div>
                  {notes.length > 0 && (
                    <div className="grid gap-2">
                      <p className="text-xs text-ink-3">进展</p>
                      <Panel as="ul" className="grid px-4">
                        {notes.map((note) => (
                          <li
                            key={`${note.at}-${note.text}`}
                            className="grid gap-0.5 border-line border-b py-2.5 last:border-b-0"
                          >
                            <span className="text-sm text-ink">
                              {note.text}
                            </span>
                            <span className="text-xs text-ink-3">
                              {agoLabel(Date.parse(note.at))}
                            </span>
                          </li>
                        ))}
                      </Panel>
                    </div>
                  )}
                </div>
              )}
            </DetailPart>
          </Swap>
        </div>
      </div>
      <ConfirmDialog
        open={asking}
        onClose={() => setAsking(false)}
        busy={remove.isPending}
        title="删掉这个需求？"
        text="删掉后，这个需求和它收到的赞都会消失。"
        error={error}
        actions={
          <>
            <Button
              onClick={() => {
                if (!remove.isPending) setAsking(false);
              }}
              aria-disabled={remove.isPending || undefined}
            >
              返回
            </Button>
            <Button
              variant="danger"
              aria-disabled={remove.isPending || undefined}
              onClick={() => {
                if (!item || remove.isPending) return;
                setError(null);
                remove.mutate(item.id, {
                  onSuccess: () => {
                    setAsking(false);
                    onClose();
                  },
                  onError: (failure) =>
                    setError(
                      refused(failure)
                        ? failure.message
                        : "删掉没有完成：网络或服务出了问题。可以再试一次。",
                    ),
                });
              }}
            >
              {remove.isPending ? "正在删除…" : error ? "再试一次" : "删掉"}
            </Button>
          </>
        }
      />
    </WindowDialog>
  );
}

/** ?item=<编号>: one opened, in the address so it can be shared (§2.5). */
function useOpenItem() {
  const router = useRouter();
  const [id, setId] = useState<string | null>(() => {
    const raw = (router.state.location.search as Record<string, unknown>).item;
    return typeof raw === "string" ? raw : null;
  });
  const set = (next: string | null) => {
    setId(next);
    const url = new URL(window.location.href);
    if (next) url.searchParams.set("item", next);
    else url.searchParams.delete("item");
    router.history.replace(
      `${url.pathname}${url.search}`,
      router.history.location.state,
    );
  };
  return [id, set] as const;
}

export function RoadmapView() {
  const { user } = useIdentity();
  const { openAccount } = useOmniboxController();
  const summary = useRoadmapSummary();
  const [sort, setSort] = useSearchChoice<RoadmapSort>("sort", "hot", [
    "hot",
    "new",
  ]);
  const requests = useRoadmapList("request", sort);
  const { items: requestItems, lazy } = listOf(requests);
  const requestList = useQueryLazyList(lazy);
  // 已完成 or 不做的, open in a dialog.
  const [folded, setFolded] = useState<"done" | "declined" | null>(null);
  const [openId, setOpenId] = useOpenItem();
  const [asking, setAsking] = useState(false);
  const [editing, setEditing] = useState<RoadmapItem | null>(null);
  const ask = () => {
    if (!user) return openAccount();
    setEditing(null);
    setAsking(true);
  };
  const counts = summary.data?.counts;
  const building = summary.data?.building ?? [];
  return (
    <PageLoad load={queryLoad(summary)}>
      {summary.data && (
        <Page>
          <PageHeader
            title="施工中"
            description="站长正在做的、做完了的，还有大家想要的。想要哪个，就给它点个赞。"
            actions={
              <Button variant="primary" onClick={ask}>
                提一个需求
              </Button>
            }
            refreshable
          />
          <PageSection
            title={
              <>
                正在施工
                <span className="ml-1.5 text-sm font-normal text-ink-3">
                  {building.length} 件
                </span>
              </>
            }
          >
            {building.length === 0 ? (
              <EmptyNote title="现在没有在施工的。" />
            ) : (
              <Cards>
                {building.map((item) => (
                  <BuildingCard
                    key={item.id}
                    item={item}
                    onOpen={() => setOpenId(item.id)}
                    onGuest={openAccount}
                  />
                ))}
              </Cards>
            )}
            {(counts?.done ?? 0) > 0 && (
              <FoldedButton
                label={`已完成 ${counts?.done} 件`}
                onOpen={() => setFolded("done")}
              />
            )}
          </PageSection>
          <PageSection
            title="功能请求"
            action={
              <Segmented
                size="sm"
                label="功能请求排序"
                value={sort}
                onChange={setSort}
                options={[
                  { value: "hot", label: "最热" },
                  { value: "new", label: "最新" },
                ]}
              />
            }
          >
            <RequestGrid
              query={requests}
              list={requestList}
              items={requestItems}
              total={counts?.request}
              onOpen={setOpenId}
              onGuest={openAccount}
              empty={
                <EmptyNote
                  title="还没有人提需求。"
                  action={
                    <Button variant="quiet" size="sm" onClick={ask}>
                      提一个需求
                    </Button>
                  }
                />
              }
            />
            {(counts?.declined ?? 0) > 0 && (
              <FoldedButton
                label={`不做的 ${counts?.declined} 件`}
                onOpen={() => setFolded("declined")}
              />
            )}
          </PageSection>
          {/* Each opens its own one over it; the page's below stays shut. */}
          <FoldedDialog
            open={folded === "done"}
            title={`已完成 · ${counts?.done ?? 0} 件`}
            onClose={() => setFolded(null)}
          >
            <DoneList total={counts?.done} onOpen={setOpenId} />
            <ItemDialog
              id={openId}
              onClose={() => setOpenId(null)}
              onGuest={openAccount}
            />
          </FoldedDialog>
          <FoldedDialog
            open={folded === "declined"}
            title={`不做的 · ${counts?.declined ?? 0} 件`}
            onClose={() => setFolded(null)}
          >
            <DeclinedList total={counts?.declined} onOpen={setOpenId} />
            <ItemDialog
              id={openId}
              onClose={() => setOpenId(null)}
              onGuest={openAccount}
            />
          </FoldedDialog>
          <RequestDialog
            open={asking}
            editing={editing}
            onClose={() => setAsking(false)}
            onOpen={(id) => {
              setAsking(false);
              setOpenId(id);
            }}
            onGuest={openAccount}
            onDone={() => {
              setAsking(false);
              if (!editing) setSort("new");
            }}
          />
          <ItemDialog
            id={folded ? null : openId}
            onClose={() => setOpenId(null)}
            onGuest={openAccount}
            onEdit={(item) => {
              setOpenId(null);
              setEditing(item);
              setAsking(true);
            }}
          />
        </Page>
      )}
    </PageLoad>
  );
}
