import {
  ROADMAP_LIMITS,
  type RoadmapAdminAction,
  type RoadmapItem,
  type RoadmapStatus,
} from "@hb/contracts";
import { ChevronRight } from "lucide-react";
import { type ReactNode, useEffect, useId, useState } from "react";
import { refused } from "../../../lib/activities";
import { cn } from "../../../lib/cn";
import {
  useAdminRoadmap,
  useAdminRoadmapAct,
  useAdminRoadmapCreate,
  useRoadmapSimilar,
} from "../../../lib/roadmap";
import { agoLabel } from "../../../lib/roster-time";
import { counter } from "../../hongbao-form/fields";
import { LazyListEnd, useQueryLazyList } from "../../page/lazy-list";
import { EmptyNote, Panel } from "../../page/page";
import { PageLoad, ResultLoad, resultOf } from "../../page/page-state";
import { useSearchChoice } from "../../shell/use-search-choice";
import { WindowDialog } from "../../shell/window-dialog";
import { Button } from "../../ui/button";
import { Field, Segmented, TextArea, TextInput } from "../../ui/field";
import { Reveal } from "../../ui/reveal";
import { StatusChip } from "../../ui/status-chip";
import { AdminFrame, listLoad } from "./admin-frame";

// 网站管理 · 施工 (docs/roadmap-design.md §4): the 站长 runs 施工中 here —
// 开工, 写一句进展, 完成, 不做, 合并, 退回, 改, 隐藏 — each kept in 操作记录.

const statuses = ["request", "building", "done", "declined"] as const;

type Asking =
  | { kind: "note" | "decline" | "merge" | "edit"; item: RoadmapItem }
  | { kind: "create" }
  | null;

/** A dialog's frame: its title, its fields, its error and its two buttons. */
function ActDialog({
  open,
  title,
  busy,
  error,
  confirm,
  onConfirm,
  onClose,
  children,
}: {
  open: boolean;
  title: string;
  busy: boolean;
  error: string | null;
  /** The confirming button; none when each row picks (合并到). */
  confirm?: string;
  onConfirm?: () => void;
  onClose: () => void;
  children: ReactNode;
}) {
  const titleId = useId();
  return (
    <WindowDialog
      open={open}
      onClose={onClose}
      labelledBy={titleId}
      busy={busy}
      width="30rem"
    >
      <form
        className="grid gap-4 p-5"
        onSubmit={(event) => {
          event.preventDefault();
          if (!busy) onConfirm?.();
        }}
      >
        <h2 id={titleId} className="text-lg font-semibold text-ink">
          {title}
        </h2>
        {children}
        <Reveal show={Boolean(error)}>
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        </Reveal>
        <div className="flex justify-end gap-2">
          <Button onClick={onClose} aria-disabled={busy || undefined}>
            取消
          </Button>
          {confirm && (
            <Button
              type="submit"
              variant="primary"
              aria-disabled={busy || undefined}
            >
              {busy ? "正在保存…" : confirm}
            </Button>
          )}
        </div>
      </form>
    </WindowDialog>
  );
}

/** 合并到… (§4): the one it goes into, found by its title. */
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
  const found = useRoadmapSimilar(q);
  const choices = (found.data?.items ?? []).filter(
    (other) => other.id !== item.id,
  );
  return (
    <div className="grid gap-3">
      <Field label="合并到哪一件" htmlFor="roadmap-merge">
        <TextInput
          id="roadmap-merge"
          value={q}
          autoComplete="off"
          placeholder="输入标题找一找"
          onChange={(event) => setQ(event.target.value)}
        />
      </Field>
      <Panel className="grid gap-0.5 p-1.5">
        {choices.length === 0 ? (
          <p className="px-2.5 py-2 text-sm text-ink-3">没有找到像的</p>
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
                aria-disabled={busy || undefined}
                onClick={() => {
                  if (!busy) onPick(other);
                }}
              >
                合并到这一件
              </Button>
            </div>
          ))
        )}
      </Panel>
    </div>
  );
}

/** One line, its moves under it once opened, as its status allows. */
function Row({
  item,
  busy,
  onAct,
  onAsk,
}: {
  item: RoadmapItem;
  busy: boolean;
  onAct: (action: RoadmapAdminAction) => void;
  onAsk: (kind: "note" | "decline" | "merge" | "edit") => void;
}) {
  const [open, setOpen] = useState(false);
  const move = (label: string, run: () => void, primary = false) => (
    <Button
      key={label}
      size="sm"
      variant={primary ? "primary" : "quiet"}
      aria-disabled={busy || undefined}
      onClick={() => {
        if (!busy) run();
      }}
    >
      {label}
    </Button>
  );
  const hide = item.hidden
    ? move("取消隐藏", () => onAct({ action: "unhide" }))
    : move("隐藏", () => onAct({ action: "hide" }));
  const edit = move("改", () => onAsk("edit"));
  const moves =
    item.status === "request"
      ? [
          move("开工", () => onAct({ action: "start" }), true),
          move("不做", () => onAsk("decline")),
          move("合并到…", () => onAsk("merge")),
          edit,
          hide,
        ]
      : item.status === "building"
        ? [
            move("写一句进展", () => onAsk("note"), true),
            move("完成", () => onAct({ action: "done" })),
            move("不做", () => onAsk("decline")),
            move("退回功能请求", () => onAct({ action: "back" })),
            edit,
            hide,
          ]
        : item.status === "done"
          ? [move("撤回到施工中", () => onAct({ action: "back" })), edit, hide]
          : [
              move("恢复成功能请求", () => onAct({ action: "back" })),
              edit,
              hide,
            ];
  return (
    <li className="border-line border-b last:border-b-0">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className={cn(
          "flex w-full items-center gap-3 rounded-[12px] px-3 py-3 text-left transition-colors hover:bg-fill-2",
          item.hidden && "opacity-60",
        )}
      >
        <span className="grid min-w-0 flex-1 gap-0.5">
          <span className="flex min-w-0 items-center gap-2">
            <span className="truncate text-base font-medium text-ink">
              {item.title}
            </span>
            {item.hidden && <StatusChip>隐藏</StatusChip>}
          </span>
          <span className="truncate text-sm text-ink-3">
            {item.byOwner ? "站长" : `@${item.author.username}`} · {item.votes}{" "}
            赞 · {agoLabel(Date.parse(item.createdAt))}
            {item.reason ? ` · 不做：${item.reason}` : ""}
            {item.note ? ` · “${item.note.text}”` : ""}
          </span>
        </span>
        <ChevronRight
          className={cn(
            "size-4 shrink-0 text-ink-3 transition-transform",
            open && "rotate-90",
          )}
          aria-hidden="true"
        />
      </button>
      <Reveal show={open}>
        <div className="grid gap-2 px-3 pb-3">
          {item.detail && (
            <p className="text-sm whitespace-pre-wrap text-ink-2">
              {item.detail}
            </p>
          )}
          <div className="flex flex-wrap gap-2">{moves}</div>
        </div>
      </Reveal>
    </li>
  );
}

const failed = (failure: unknown) =>
  refused(failure)
    ? failure.message
    : "没有保存：网络或服务出了问题。可以再试一次。";

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
  const [asking, setAsking] = useState<Asking>(null);
  const [error, setError] = useState<string | null>(null);
  const [rowError, setRowError] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [title, setTitle] = useState("");
  const [detail, setDetail] = useState("");
  const [into, setInto] = useState<"request" | "building">("building");
  // Each opening starts from what it changes.
  useEffect(() => {
    setError(null);
    setText("");
    if (asking?.kind === "edit") {
      setTitle(asking.item.title);
      setDetail(asking.item.detail);
    } else if (asking?.kind === "create") {
      setTitle("");
      setDetail("");
      setInto("building");
    }
  }, [asking]);
  const busy = act.isPending || create.isPending;
  const run = (id: string, action: RoadmapAdminAction, inDialog = false) => {
    setRowError(null);
    act.mutate(
      { id, action },
      {
        onSuccess: () => setAsking(null),
        onError: (failure) =>
          inDialog ? setError(failed(failure)) : setRowError(failed(failure)),
      },
    );
  };
  const close = () => {
    if (!busy) setAsking(null);
  };
  const item = asking && asking.kind !== "create" ? asking.item : null;
  return (
    <PageLoad load={listLoad(query)} area frame>
      <AdminFrame>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Segmented
            size="sm"
            label="施工分类"
            value={status}
            onChange={setStatus}
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
            onClick={() => setAsking({ kind: "create" })}
          >
            新建
          </Button>
        </div>
        <Reveal show={Boolean(rowError)}>
          <p role="alert" className="text-sm text-danger">
            {rowError}
          </p>
        </Reveal>
        <ResultLoad id={status} load={resultOf(query)}>
          {items.length === 0 ? (
            <EmptyNote title="这里还没有" />
          ) : (
            <Panel className="grid p-1.5">
              <ul className="grid">
                {items.map((row) => (
                  <Row
                    key={row.id}
                    item={row}
                    busy={busy}
                    onAct={(action) => run(row.id, action)}
                    onAsk={(kind) => setAsking({ kind, item: row })}
                  />
                ))}
              </ul>
              <LazyListEnd list={list} done="已全部加载" />
            </Panel>
          )}
        </ResultLoad>
        <ActDialog
          open={asking?.kind === "note"}
          title="写一句进展"
          busy={busy}
          error={error}
          confirm="保存"
          onClose={close}
          onConfirm={() => {
            if (item) run(item.id, { action: "note", text: text.trim() }, true);
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
        </ActDialog>
        <ActDialog
          open={asking?.kind === "decline"}
          title={`不做「${item?.title ?? ""}」？`}
          busy={busy}
          error={error}
          confirm="不做"
          onClose={close}
          onConfirm={() => {
            if (item)
              run(item.id, { action: "decline", reason: text.trim() }, true);
          }}
        >
          <Field
            label="原因"
            htmlFor="roadmap-reason"
            hint="施工页上写在这一件下面"
            aside={counter(text.trim(), ROADMAP_LIMITS.reason)}
          >
            <TextInput
              id="roadmap-reason"
              value={text}
              autoComplete="off"
              onChange={(event) => setText(event.target.value)}
            />
          </Field>
        </ActDialog>
        <ActDialog
          open={asking?.kind === "merge"}
          title={`合并「${item?.title ?? ""}」`}
          busy={busy}
          error={error}
          onClose={close}
        >
          {item && (
            <MergePicker
              item={item}
              busy={busy}
              onPick={(other) =>
                run(item.id, { action: "merge", into: other.id }, true)
              }
            />
          )}
          <p className="text-sm text-ink-3">
            赞合到那一件，同一个人只算一次；这一件不再显示。
          </p>
        </ActDialog>
        <ActDialog
          open={asking?.kind === "edit" || asking?.kind === "create"}
          title={asking?.kind === "create" ? "新建" : "改"}
          busy={busy}
          error={error}
          confirm={asking?.kind === "create" ? "新建" : "保存"}
          onClose={close}
          onConfirm={() => {
            if (asking?.kind === "create")
              create.mutate(
                { title: title.trim(), detail: detail.trim(), status: into },
                {
                  onSuccess: () => {
                    setAsking(null);
                    setStatus(into);
                  },
                  onError: (failure) => setError(failed(failure)),
                },
              );
            else if (item)
              run(
                item.id,
                { action: "edit", title: title.trim(), detail: detail.trim() },
                true,
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
          {asking?.kind === "create" && (
            <div>
              <Segmented
                size="sm"
                label="放进"
                value={into}
                onChange={setInto}
                options={[
                  { value: "building", label: "施工中" },
                  { value: "request", label: "功能请求" },
                ]}
              />
            </div>
          )}
        </ActDialog>
      </AdminFrame>
    </PageLoad>
  );
}
