import {
  ROADMAP_LIMITS,
  type RoadmapAdminAction,
  type RoadmapItem,
  type RoadmapStatus,
} from "@hb/contracts";
import { Fragment, type ReactNode, useId, useRef, useState } from "react";
import { refused } from "../../../lib/activities";
import { cn } from "../../../lib/cn";
import {
  useAdminRoadmap,
  useAdminRoadmapAct,
  useAdminRoadmapCreate,
  useRoadmapSimilar,
} from "../../../lib/roadmap";
import { agoLabel, clockLabel } from "../../../lib/roster-time";
import { counter } from "../../hongbao-form/fields";
import { useQueryLazyList } from "../../page/lazy-list";
import { EmptyNote, Panel } from "../../page/page";
import { Bone, PageLoad, resultOf } from "../../page/page-state";
import { ConfirmDialog } from "../../shell/confirm-dialog";
import { useSearchChoice } from "../../shell/use-search-choice";
import { StacksDialogs } from "../../shell/window-dialog";
import { useWindowInfo } from "../../shell/window-info";
import { Button } from "../../ui/button";
import {
  ChoiceCards,
  Field,
  Segmented,
  TextArea,
  TextInput,
} from "../../ui/field";
import { Reveal } from "../../ui/reveal";
import { StatusChip } from "../../ui/status-chip";
import {
  AdminFrame,
  DetailRetry,
  DetailRows,
  ListDetail,
  listLoad,
  useSettled,
} from "./admin-frame";

// 网站管理 · 施工 (docs/roadmap-design.md §4): the 站长 runs 施工中 here —
// 开工, 写一句进展, 完成, 不做, 合并, 退回, 改, 隐藏 — each kept in 操作记录.
// A list with the chosen one's detail beside it (07 §10), its moves there.

const statuses = ["request", "building", "done", "declined"] as const;

const statusText: Record<RoadmapStatus, string> = {
  request: "功能请求",
  building: "施工中",
  done: "已完成",
  declined: "不做",
};

const emptyText: Record<RoadmapStatus, string> = {
  request: "还没有功能请求",
  building: "现在没有在施工的",
  done: "还没有已完成的",
  declined: "还没有不做的",
};

type Ask = "note" | "decline" | "merge" | "edit";

type Asking = { kind: Ask; item: RoadmapItem } | { kind: "create" } | null;

/** A button in the detail: done at once, or asking first. */
type Move = { label: string; primary?: boolean } & (
  | { action: RoadmapAdminAction; what: string }
  | { ask: Ask }
);

/** What one can do to it, as its status allows. */
function movesOf(item: RoadmapItem): Move[] {
  const edit: Move = { label: "改", ask: "edit" };
  const hide: Move = item.hidden
    ? { label: "取消隐藏", action: { action: "unhide" }, what: "取消隐藏" }
    : { label: "隐藏", action: { action: "hide" }, what: "隐藏" };
  switch (item.status) {
    case "request":
      return [
        {
          label: "开工",
          action: { action: "start" },
          what: "开工",
          primary: true,
        },
        { label: "不做", ask: "decline" },
        { label: "标为重复…", ask: "merge" },
        edit,
        hide,
      ];
    case "building":
      return [
        { label: "写一句进展", ask: "note", primary: true },
        { label: "完成", action: { action: "done" }, what: "标为已完成" },
        { label: "不做", ask: "decline" },
        {
          label: "退回功能请求",
          action: { action: "back" },
          what: "退回功能请求",
        },
        edit,
        hide,
      ];
    case "done":
      return [
        {
          label: "撤回到施工中",
          action: { action: "back" },
          what: "撤回到施工中",
        },
        edit,
        hide,
      ];
    default:
      return [
        {
          label: "恢复成功能请求",
          action: { action: "back" },
          what: "恢复成功能请求",
        },
        edit,
        hide,
      ];
  }
}

const failed = (what: string, failure: unknown) =>
  refused(failure)
    ? failure.message
    : `${what}没有完成：网络或服务出了问题。可以再试一次。`;

const whoOf = (item: RoadmapItem) =>
  item.byOwner ? "站长" : `@${item.author.username}`;

/** A row: the title, who asked, its votes and when (§4). */
function RowBody({ item }: { item: RoadmapItem }) {
  return (
    <span
      className={cn("grid min-w-0 flex-1 gap-0.5", item.hidden && "opacity-60")}
    >
      <span className="flex min-w-0 items-center gap-2">
        <span className="truncate text-base font-medium text-ink">
          {item.title}
        </span>
        {item.hidden && <StatusChip>隐藏</StatusChip>}
      </span>
      <span className="truncate text-xs text-ink-3">
        {whoOf(item)} · {item.votes} 赞 · {agoLabel(Date.parse(item.createdAt))}
      </span>
    </span>
  );
}

/** The chosen one: what it is, then its moves; a move's failure under them. */
function Detail({
  item,
  error,
  children,
}: {
  item: RoadmapItem;
  error: string | null;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-1">
        <p className="text-base font-semibold text-ink [overflow-wrap:anywhere]">
          {item.title}
        </p>
        <p className="text-xs text-ink-3">
          {statusText[item.status]}
          {item.hidden ? " · 隐藏中，施工页上看不到" : ""}
        </p>
      </div>
      {item.detail && (
        <p className="text-sm whitespace-pre-wrap text-ink-2 [overflow-wrap:anywhere]">
          {item.detail}
        </p>
      )}
      <DetailRows
        rows={[
          { label: "提的人", value: whoOf(item) },
          { label: "赞", value: `${item.votes} 个` },
          { label: "提出", value: clockLabel(Date.parse(item.createdAt)) },
          ...(item.startedAt
            ? [{ label: "开工", value: clockLabel(Date.parse(item.startedAt)) }]
            : []),
          ...(item.doneAt
            ? [{ label: "完成", value: clockLabel(Date.parse(item.doneAt)) }]
            : []),
          ...(item.reason ? [{ label: "不做的原因", value: item.reason }] : []),
          ...(item.note
            ? [
                {
                  label: "最近的进展",
                  value: `“${item.note.text}” · ${agoLabel(Date.parse(item.note.at))}`,
                },
              ]
            : []),
        ]}
      />
      <Reveal show={Boolean(error)}>
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      </Reveal>
      <div className="flex flex-wrap gap-2">{children}</div>
    </div>
  );
}

/**
 * A question with fields (写一句进展, 不做, 改, 新建): Enter in a field
 * answers it; 返回 first, the answer last, 再试一次 after a failure.
 */
function AskDialog({
  open,
  title,
  text,
  busy,
  error,
  confirm,
  danger = false,
  onConfirm,
  onClose,
  children,
}: {
  open: boolean;
  title: string;
  text: string;
  busy: boolean;
  error: string | null;
  /** The answering button; none when each row picks (标为重复). */
  confirm?: string;
  danger?: boolean;
  onConfirm?: () => void;
  onClose: () => void;
  children: ReactNode;
}) {
  const formId = useId();
  return (
    <ConfirmDialog
      open={open}
      onClose={onClose}
      busy={busy}
      title={title}
      text={text}
      error={error}
      actions={
        <>
          <Button
            aria-disabled={busy || undefined}
            onClick={() => {
              if (!busy) onClose();
            }}
          >
            返回
          </Button>
          {confirm && (
            <Button
              type="submit"
              form={formId}
              variant={danger ? "danger" : "primary"}
              aria-disabled={busy || undefined}
            >
              {busy ? "正在保存…" : error ? "再试一次" : confirm}
            </Button>
          )}
        </>
      }
    >
      <form
        id={formId}
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          if (!busy) onConfirm?.();
        }}
      >
        {children}
      </form>
    </ConfirmDialog>
  );
}

/**
 * 标为重复 (§4): the one it duplicates, found by its title once typing
 * pauses; “就是这个” then asks first.
 */
function MergePicker({
  item,
  busy,
  onPick,
}: {
  item: RoadmapItem;
  busy: boolean;
  onPick: (into: RoadmapItem) => void;
}) {
  const [q, setQ] = useState(item.title);
  const searched = useSettled(q.trim());
  const found = useRoadmapSimilar(searched);
  // Too short to search: nothing, not the last search's.
  const choices =
    Array.from(searched).length >= 2
      ? (found.data?.items ?? []).filter((other) => other.id !== item.id)
      : [];
  const reading = found.data === undefined && found.isFetching;
  return (
    <div className="flex flex-col gap-3">
      <Field label="搜索需求" htmlFor="roadmap-merge">
        <TextInput
          id="roadmap-merge"
          value={q}
          autoComplete="off"
          placeholder="输入标题搜索"
          onChange={(event) => setQ(event.target.value)}
        />
      </Field>
      <DetailRetry query={found} what="相似的需求" />
      <Panel
        className={cn(
          "flex flex-col gap-0.5 p-1.5 transition-opacity",
          found.isPlaceholderData && "opacity-60",
        )}
      >
        {reading ? (
          <div className="grid gap-3 px-2.5 py-2.5">
            <p role="status" className="sr-only">
              正在读取…
            </p>
            <Bone className="h-3 w-2/3" />
            <Bone className="h-3 w-1/2" />
          </div>
        ) : choices.length === 0 ? (
          <p className="px-2.5 py-2 text-sm text-ink-3">没有找到相似的需求</p>
        ) : (
          choices.map((other) => (
            <div
              key={other.id}
              className="flex items-center justify-between gap-3 px-2.5 py-2"
            >
              <span className="min-w-0 truncate text-sm text-ink">
                {other.status === "building" ? "施工中 · " : ""}
                {other.title}
                <span className="ml-1 text-ink-3">· {other.votes} 赞</span>
              </span>
              <Button
                size="xs"
                aria-haspopup="dialog"
                aria-disabled={busy || undefined}
                onClick={() => {
                  if (!busy) onPick(other);
                }}
              >
                就是这个
              </Button>
            </div>
          ))
        )}
      </Panel>
    </div>
  );
}

/** /admin/roadmap 施工: the four lists, 新建, and every move. */
export function AdminRoadmap() {
  const [status, setStatus] = useSearchChoice<RoadmapStatus>(
    "status",
    "request",
    statuses,
  );
  const query = useAdminRoadmap(status);
  const act = useAdminRoadmapAct();
  const create = useAdminRoadmapCreate();
  const list = useQueryLazyList({
    hasNextPage: query.hasNextPage,
    isFetchingNextPage: query.isFetchingNextPage,
    isFetchNextPageError: query.isFetchNextPageError,
    fetchNextPage: query.fetchNextPage,
    pageCount: query.data?.pages.length ?? 0,
    isPlaceholderData: query.isPlaceholderData,
  });
  const items = query.data?.pages.flatMap((page) => page.items) ?? [];
  const counts = query.data?.pages[0]?.counts;
  const [selected, setSelected] = useState<string | null>(null);
  const [asking, setAsking] = useState<Asking>(null);
  // Kept while its dialog closes, so its words stay.
  const lastAsked = useRef<Asking>(null);
  if (asking) lastAsked.current = asking;
  const shown = asking ?? lastAsked.current;
  const [error, setError] = useState<string | null>(null);
  const [moveError, setMoveError] = useState<{
    id: string;
    text: string;
  } | null>(null);
  const [text, setText] = useState("");
  const [title, setTitle] = useState("");
  const [detail, setDetail] = useState("");
  const [place, setPlace] = useState<"request" | "building">("building");
  const [mergeInto, setMergeInto] = useState<RoadmapItem | null>(null);
  const busy = act.isPending || create.isPending;
  // Narrower windows show the detail in a dialog: what it opens stacks
  // over it.
  const { roomy } = useWindowInfo();
  const Layer = roomy ? Fragment : StacksDialogs;

  const choose = (next: RoadmapStatus) => {
    setSelected(null);
    setMoveError(null);
    setStatus(next);
  };
  /** Opening a question starts it from what it changes. */
  const ask = (next: NonNullable<Asking>) => {
    setError(null);
    setText("");
    setMergeInto(null);
    if (next.kind === "edit") {
      setTitle(next.item.title);
      setDetail(next.item.detail);
    } else if (next.kind === "create") {
      setTitle("");
      setDetail("");
      setPlace("building");
    }
    setAsking(next);
  };
  const close = () => {
    if (!busy) setAsking(null);
  };
  /** A move asked in a dialog: its failure stays in the dialog. */
  const answer = (id: string, action: RoadmapAdminAction, what: string) => {
    if (busy) return;
    setError(null);
    act.mutate(
      { id, action },
      {
        onSuccess: () => {
          setMergeInto(null);
          setAsking(null);
        },
        onError: (failure) => setError(failed(what, failure)),
      },
    );
  };
  const asked = shown && shown.kind !== "create" ? shown.item : null;

  const moveButtons = (item: RoadmapItem) =>
    movesOf(item).map((move) => {
      const pending =
        "action" in move &&
        act.isPending &&
        act.variables?.id === item.id &&
        act.variables.action.action === move.action.action;
      return (
        <Button
          key={move.label}
          size="sm"
          variant={move.primary ? "primary" : "quiet"}
          aria-haspopup={"ask" in move ? "dialog" : undefined}
          aria-disabled={busy || undefined}
          onClick={() => {
            if (busy) return;
            setMoveError(null);
            if ("ask" in move) return ask({ kind: move.ask, item });
            act.mutate(
              { id: item.id, action: move.action },
              {
                onError: (failure) =>
                  setMoveError({
                    id: item.id,
                    text: failed(move.what, failure),
                  }),
              },
            );
          }}
        >
          {pending ? "正在保存…" : move.label}
        </Button>
      );
    });

  return (
    <PageLoad load={listLoad(query)} area frame>
      <AdminFrame>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Segmented
            size="sm"
            label="施工分类"
            value={status}
            onChange={choose}
            options={[
              { value: "request", label: "功能请求", count: counts?.request },
              { value: "building", label: "施工中", count: counts?.building },
              { value: "done", label: "已完成", count: counts?.done },
              { value: "declined", label: "不做的", count: counts?.declined },
            ]}
          />
          <Button
            variant="primary"
            size="sm"
            aria-haspopup="dialog"
            onClick={() => ask({ kind: "create" })}
          >
            新建
          </Button>
        </div>
        <ListDetail
          items={items}
          list={list}
          total={counts?.[status]}
          load={resultOf(query)}
          selectedId={selected}
          onSelect={(id) => {
            setMoveError(null);
            setSelected(id);
          }}
          placeholder="点一件看详情。"
          unit="件"
          noun="需求"
          empty={<EmptyNote title={emptyText[status]} />}
          row={(item) => <RowBody item={item} />}
          detail={(item) => (
            <Detail
              item={item}
              error={moveError?.id === item.id ? moveError.text : null}
            >
              {moveButtons(item)}
            </Detail>
          )}
        />
        <Layer>
          <AskDialog
            open={asking?.kind === "note"}
            title="写一句进展"
            text={`会显示在施工页上「${asked?.title ?? ""}」的卡片里，点开能看到写过的每一句。`}
            busy={busy}
            error={error}
            confirm="保存"
            onClose={close}
            onConfirm={() => {
              if (asked)
                answer(
                  asked.id,
                  { action: "note", text: text.trim() },
                  "保存进展",
                );
            }}
          >
            <Field
              label="进展"
              htmlFor="roadmap-note"
              aside={counter(text.trim(), ROADMAP_LIMITS.note)}
            >
              <TextInput
                id="roadmap-note"
                value={text}
                autoComplete="off"
                placeholder="比如：在写按人的列表"
                onChange={(event) => setText(event.target.value)}
              />
            </Field>
          </AskDialog>
          <AskDialog
            open={asking?.kind === "decline"}
            title={`不做「${asked?.title ?? ""}」？`}
            text="它会移到施工页的“不做的”里，以后可以恢复成功能请求。"
            busy={busy}
            error={error}
            confirm="不做"
            onClose={close}
            onConfirm={() => {
              if (asked)
                answer(
                  asked.id,
                  { action: "decline", reason: text.trim() },
                  "不做",
                );
            }}
          >
            <Field
              label="原因"
              htmlFor="roadmap-reason"
              hint="会显示在施工页上这个需求的下面"
              aside={counter(text.trim(), ROADMAP_LIMITS.reason)}
            >
              <TextInput
                id="roadmap-reason"
                value={text}
                autoComplete="off"
                onChange={(event) => setText(event.target.value)}
              />
            </Field>
          </AskDialog>
          <AskDialog
            open={asking?.kind === "merge"}
            title={`「${asked?.title ?? ""}」和哪个需求重复？`}
            text="找到它重复的那一件，点“就是这个”，确认以后合并。"
            busy={busy}
            error={null}
            onClose={close}
          >
            {asked && (
              <MergePicker item={asked} busy={busy} onPick={setMergeInto} />
            )}
            {/* Over the picker: merging cannot be undone. */}
            <ConfirmDialog
              open={mergeInto !== null && asking?.kind === "merge"}
              onClose={() => {
                if (busy) return;
                setMergeInto(null);
                setError(null);
              }}
              busy={busy}
              title={`把「${asked?.title ?? ""}」标为「${mergeInto?.title ?? ""}」的重复？`}
              text={`「${asked?.title ?? ""}」不再显示，它收到的赞加到「${mergeInto?.title ?? ""}」上；两个都点过赞的人只算一个赞。合并以后不能撤销。`}
              error={error}
              actions={
                <>
                  <Button
                    aria-disabled={busy || undefined}
                    onClick={() => {
                      if (busy) return;
                      setMergeInto(null);
                      setError(null);
                    }}
                  >
                    返回
                  </Button>
                  <Button
                    variant="danger"
                    aria-disabled={busy || undefined}
                    onClick={() => {
                      if (asked && mergeInto)
                        answer(
                          asked.id,
                          { action: "merge", into: mergeInto.id },
                          "标为重复",
                        );
                    }}
                  >
                    {busy ? "正在合并…" : error ? "再试一次" : "标为重复"}
                  </Button>
                </>
              }
            />
          </AskDialog>
          <AskDialog
            open={asking?.kind === "edit" || asking?.kind === "create"}
            title={
              shown?.kind === "create" ? "新建" : `改「${asked?.title ?? ""}」`
            }
            text={
              shown?.kind === "create"
                ? "新建一件站长自己提的需求。"
                : "改的是施工页上显示的标题和说明。"
            }
            busy={busy}
            error={error}
            confirm={shown?.kind === "create" ? "新建" : "保存"}
            onClose={close}
            onConfirm={() => {
              if (busy) return;
              if (asking?.kind === "create") {
                setError(null);
                create.mutate(
                  { title: title.trim(), detail: detail.trim(), status: place },
                  {
                    onSuccess: () => {
                      setAsking(null);
                      choose(place);
                    },
                    onError: (failure) => setError(failed("新建", failure)),
                  },
                );
              } else if (asked)
                answer(
                  asked.id,
                  {
                    action: "edit",
                    title: title.trim(),
                    detail: detail.trim(),
                  },
                  "保存修改",
                );
            }}
          >
            <Field
              label="标题"
              htmlFor="roadmap-admin-title"
              aside={counter(title.trim(), ROADMAP_LIMITS.title)}
            >
              <TextInput
                id="roadmap-admin-title"
                value={title}
                autoComplete="off"
                onChange={(event) => setTitle(event.target.value)}
              />
            </Field>
            <Field
              label="说明"
              optional
              htmlFor="roadmap-admin-detail"
              aside={counter(detail.trim(), ROADMAP_LIMITS.detail)}
            >
              <TextArea
                id="roadmap-admin-detail"
                value={detail}
                rows={4}
                onChange={(event) => setDetail(event.target.value)}
              />
            </Field>
            {shown?.kind === "create" && (
              <Field label="放进">
                <ChoiceCards
                  label="放进"
                  value={place}
                  onChange={setPlace}
                  options={[
                    {
                      value: "building",
                      title: "施工中",
                      description: "已经在做，显示在“正在施工”里",
                    },
                    {
                      value: "request",
                      title: "功能请求",
                      description: "还没开始，和大家提的放在一起，可以点赞",
                    },
                  ]}
                />
              </Field>
            )}
          </AskDialog>
        </Layer>
      </AdminFrame>
    </PageLoad>
  );
}
