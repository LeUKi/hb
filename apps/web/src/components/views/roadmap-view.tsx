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
    return (
      <span className="inline-flex shrink-0 items-center gap-1 text-xs text-ink-3 tabular-nums">
        <ThumbsUp className="size-3.5" aria-hidden="true" />
        <span className="sr-only">赞</span>
        {item.votes}
      </span>
    );
  return (
    <span className="grid shrink-0 justify-items-end gap-1">
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
          没有点上，再试一次。
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

/** 功能请求 and 不做的 (§2.3): a panel card, smaller than the gold. */
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
        {item.reason && (
          <p className="text-sm text-ink-2">不做：{item.reason}</p>
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

/** “已完成 N 件 ›”, “不做的 N 件 ›” (§2.2, §2.3): a line that unfolds. */
function Folded({
  label,
  open,
  onToggle,
  children,
}: {
  label: string;
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  return (
    <div className="grid gap-3">
      <button
        type="button"
        aria-expanded={open}
        onClick={onToggle}
        className="inline-flex w-fit items-center gap-0.5 px-1 text-sm text-ink-2 hover:text-ink"
      >
        {label}
        <ChevronRight
          className={cn("size-4 transition-transform", open && "rotate-90")}
          aria-hidden="true"
        />
      </button>
      <Reveal show={open}>{open && children}</Reveal>
    </div>
  );
}

/** 已完成, unfolded (§2.2): a line each, the newest first. */
function DoneList({ onOpen }: { onOpen: (id: string) => void }) {
  const query = useRoadmapList("done", "new");
  const { items, lazy } = listOf(query);
  const list = useQueryLazyList(lazy);
  return (
    <ResultLoad id="done" load={resultOf(query)}>
      <Panel className="grid gap-0.5 p-1.5">
        <ul className="grid" aria-busy={list.state === "loading" || undefined}>
          {items.map((item) => (
            <li key={item.id}>
              <button
                type="button"
                onClick={() => onOpen(item.id)}
                className="grid w-full grid-cols-[4.5rem_minmax(0,1fr)_auto] items-start gap-3 rounded-[12px] px-3 py-3 text-left transition-colors hover:bg-fill-2"
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
                <span className="inline-flex items-center gap-1 pt-0.5 text-xs text-ink-3 tabular-nums">
                  <ThumbsUp className="size-3.5" aria-hidden="true" />
                  <span className="sr-only">赞</span>
                  {item.votes}
                </span>
              </button>
            </li>
          ))}
        </ul>
        <LazyListEnd list={list} done="已全部加载" />
      </Panel>
    </ResultLoad>
  );
}

function RequestGrid({
  query,
  list,
  items,
  onOpen,
  onGuest,
  empty,
}: {
  query: Parameters<typeof resultOf>[0];
  list: LazyList;
  items: RoadmapItem[];
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
          <LazyListEnd list={list} done="已全部加载" />
        </div>
      )}
    </ResultLoad>
  );
}

function DeclinedList({
  onOpen,
  onGuest,
}: {
  onOpen: (id: string) => void;
  onGuest: () => void;
}) {
  const query = useRoadmapList("declined", "new");
  const { items, lazy } = listOf(query);
  const list = useQueryLazyList(lazy);
  return (
    <RequestGrid
      query={query}
      list={list}
      items={items}
      onOpen={onOpen}
      onGuest={onGuest}
      empty={<EmptyNote title="没有不做的" />}
    />
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
  const similar = useRoadmapSimilar(editing ? "" : title);
  const like = (similar.data?.items ?? []).filter(
    (item) => item.id !== editing?.id,
  );
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
              : "没有提交上：网络或服务出了问题。可以再试一次。",
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
        className="grid gap-4 p-5"
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
            <p className="px-1 text-xs text-ink-3">可能已经有人提了</p>
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
              一样的话，给它点个赞就行。
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
  onEdit: (item: RoadmapItem) => void;
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
            {item ? (
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
                    item.status === "building" && startedLabel(item.startedAt),
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
                        onClick={() => onEdit(item)}
                      >
                        改
                      </Button>
                      <Button
                        variant="quiet"
                        size="sm"
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
                {(detail.data?.notes.length ?? 0) > 0 && (
                  <div className="grid gap-2">
                    <p className="text-xs text-ink-3">进展</p>
                    <Panel as="ul" className="grid px-4">
                      {detail.data?.notes.map((note) => (
                        <li
                          key={`${note.at}-${note.text}`}
                          className="grid gap-0.5 border-line border-b py-2.5 last:border-b-0"
                        >
                          <span className="text-sm text-ink">{note.text}</span>
                          <span className="text-xs text-ink-3">
                            {agoLabel(Date.parse(note.at))}
                          </span>
                        </li>
                      ))}
                    </Panel>
                  </div>
                )}
              </div>
            ) : detail.isError ? (
              <p className="flex items-center gap-3 text-sm text-danger">
                没有读到这一件
                <Button size="xs" onClick={() => void detail.refetch()}>
                  重试
                </Button>
              </p>
            ) : (
              <p role="status" className="loading-sheen text-sm text-ink-3">
                正在读取…
              </p>
            )}
          </Swap>
        </div>
      </div>
      <ConfirmDialog
        open={asking}
        onClose={() => setAsking(false)}
        busy={remove.isPending}
        title="删掉这个需求？"
        text="它和大家给它的赞一起删掉。"
        error={error}
        actions={
          <>
            <Button
              onClick={() => setAsking(false)}
              aria-disabled={remove.isPending || undefined}
            >
              返回
            </Button>
            <Button
              variant="danger"
              aria-disabled={remove.isPending || undefined}
              onClick={() => {
                if (!item || remove.isPending) return;
                remove.mutate(item.id, {
                  onSuccess: () => {
                    setAsking(false);
                    onClose();
                  },
                  onError: (failure) =>
                    setError(
                      refused(failure)
                        ? failure.message
                        : "没有删掉：网络或服务出了问题。可以再试一次。",
                    ),
                });
              }}
            >
              {remove.isPending ? "正在删除…" : "删掉"}
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
  const [doneOpen, setDoneOpen] = useState(false);
  const [declinedOpen, setDeclinedOpen] = useState(false);
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
              <Panel className="px-4 py-6 text-center text-sm text-ink-3">
                现在没有在施工的。
              </Panel>
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
              <Folded
                label={`已完成 ${counts?.done} 件`}
                open={doneOpen}
                onToggle={() => setDoneOpen(!doneOpen)}
              >
                <DoneList onOpen={setOpenId} />
              </Folded>
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
              <Folded
                label={`不做的 ${counts?.declined} 件`}
                open={declinedOpen}
                onToggle={() => setDeclinedOpen(!declinedOpen)}
              >
                <DeclinedList onOpen={setOpenId} onGuest={openAccount} />
              </Folded>
            )}
          </PageSection>
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
            id={openId}
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
