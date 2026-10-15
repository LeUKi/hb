import { useLocation } from "@tanstack/react-router";
import { RotateCw } from "lucide-react";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { cn } from "../../lib/cn";
import { Button } from "../ui/button";
import { Spinner } from "../ui/kbd";

/** How many rows a batch adds (production reads 20 at a time). */
export const PAGE_SIZE = 20;

/** Rows shown per list and history entry, so Back finds the list as it was. */
const loaded = new Map<string, number>();

export type LazyList = {
  /** How many rows to render. */
  shown: number;
  /** Ref for the end row: reaching it loads the next batch. */
  endRef: (element: HTMLElement | null) => void;
  state: "more" | "loading" | "failed" | "done";
  retry: () => void;
  /** Longer than one batch: only then is there an end row at all. */
  paged: boolean;
};

/** Calls `load` once `end` comes within 600px of the scroller's bottom. */
function useNearEnd(
  end: HTMLElement | null,
  active: boolean,
  load: () => void,
) {
  useEffect(() => {
    if (!end || !active) return;
    const root = end.closest(".view-scroll");
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((item) => item.isIntersecting)) load();
      },
      { root, rootMargin: "0px 0px 600px 0px" },
    );
    observer.observe(end);
    return () => observer.disconnect();
  }, [end, active, load]);
}

/**
 * A list read from the server 20 at a time (an infinite query): the next
 * batch loads as its end comes near, a failed batch offers 重试加载. The
 * query cache keeps the batches, so Back finds the list as it was.
 */
export function useQueryLazyList(query: {
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  isFetchNextPageError: boolean;
  fetchNextPage: () => Promise<unknown>;
  pageCount: number;
}): LazyList {
  const [end, setEnd] = useState<HTMLElement | null>(null);
  const { fetchNextPage } = query;
  const load = useCallback(() => void fetchNextPage(), [fetchNextPage]);
  const state = !query.hasNextPage
    ? "done"
    : query.isFetchingNextPage
      ? "loading"
      : query.isFetchNextPageError
        ? "failed"
        : "more";
  useNearEnd(end, state === "more", load);
  return {
    shown: Number.POSITIVE_INFINITY,
    endRef: setEnd,
    state,
    retry: load,
    paged: query.pageCount > 1 || query.hasNextPage,
  };
}

/**
 * A list whose rows are all here already, shown 20 more at a time as its
 * end comes near, in whatever scrolls it: the page, or a dialog's own list.
 * `id` names the list within its page and must change with its filter: a
 * new filter starts again at 20, and Back restores the count per history
 * entry.
 */
export function useLazyList({
  id,
  total,
  pageSize = PAGE_SIZE,
}: {
  id: string;
  total: number;
  pageSize?: number;
}): LazyList {
  // The entry this page was shown in: a filter written into the address
  // replaces it on the same path (follow it); any other change is a
  // navigation, and this page, leaving, keeps its own entry.
  const liveKey = useLocation({
    select: (current) =>
      (current.state as { __TSR_key?: string }).__TSR_key ?? "",
  });
  const pathname = useLocation({ select: (current) => current.pathname });
  const entry = useRef({ key: liveKey, pathname });
  if (pathname === entry.current.pathname)
    entry.current = { key: liveKey, pathname };
  const key = `${entry.current.key}:${id}`;

  const [list, setList] = useState(() => ({
    key,
    shown: Math.max(pageSize, loaded.get(key) ?? pageSize),
  }));
  // A new filter (or entry) starts again from what it remembers, or 20.
  const shown =
    list.key === key
      ? list.shown
      : Math.max(pageSize, loaded.get(key) ?? pageSize);
  if (list.key !== key) setList({ key, shown });
  useEffect(() => {
    loaded.set(key, shown);
  }, [key, shown]);

  const [end, setEnd] = useState<HTMLElement | null>(null);
  const more = shown < total;
  const load = useCallback(
    () =>
      setList((current) => ({ ...current, shown: current.shown + pageSize })),
    [pageSize],
  );
  // Observed again after every batch (a new `shown`): a short list whose
  // end is still in reach keeps filling itself.
  useNearEnd(end, more, load);

  return {
    shown: Math.min(shown, total),
    endRef: setEnd,
    state: more ? "more" : "done",
    retry: load,
    paged: total > pageSize,
  };
}

/**
 * The row after a lazy list: 正在加载… while more remain, production's
 * failure line with 重试加载, then the total (said once, politely). A list
 * that fits in one batch has none.
 */
export function LazyListEnd({
  list,
  done,
  className,
}: {
  list: LazyList;
  /** What the end says: "共 63 条", or "已全部加载" when the count is vague. */
  done: string;
  className?: string;
}) {
  // 重试加载 stays (as 正在加载…) while it retries, so focus stays on it;
  // when the batch is in, focus goes to this row, which then says so.
  const [retrying, setRetrying] = useState(false);
  const row = useRef<HTMLDivElement | null>(null);
  const { state, endRef } = list;
  const setRow = useCallback(
    (element: HTMLDivElement | null) => {
      row.current = element;
      endRef(element);
    },
    [endRef],
  );
  useEffect(() => {
    if (!retrying || state === "loading") return;
    setRetrying(false);
    if (state !== "failed") row.current?.focus({ preventScroll: true });
  }, [retrying, state]);
  if (!list.paged) return null;
  const retryShown = state === "failed" || (retrying && state === "loading");
  return (
    <div
      ref={setRow}
      tabIndex={-1}
      className={cn(
        "flex min-h-11 items-center justify-center gap-2 px-3 text-sm text-ink-3 outline-none",
        className,
      )}
    >
      {retryShown ? (
        <>
          {state === "failed" && (
            <span role="alert">后续记录读取失败，可重试加载。</span>
          )}
          <Button
            size="sm"
            variant="ghost"
            aria-disabled={state === "loading" || undefined}
            onClick={() => {
              if (state !== "failed") return;
              setRetrying(true);
              list.retry();
            }}
          >
            {state === "loading" ? (
              <Spinner />
            ) : (
              <RotateCw aria-hidden="true" />
            )}
            {state === "loading" ? "正在加载…" : "重试加载"}
          </Button>
        </>
      ) : (
        <span aria-live="polite" className="flex items-center gap-2">
          {state === "done" ? (
            done
          ) : (
            <>
              <Spinner />
              正在加载…
            </>
          )}
        </span>
      )}
    </div>
  );
}

/**
 * A lazy list whose markup varies: renders the rows loaded so far through
 * `children`, then the end row.
 */
export function LazyRows<T>({
  id,
  items,
  done,
  children,
}: {
  id: string;
  items: T[];
  done: string;
  children: (visible: T[]) => ReactNode;
}) {
  const list = useLazyList({ id, total: items.length });
  return (
    <>
      {children(items.slice(0, list.shown))}
      <LazyListEnd list={list} done={done} />
    </>
  );
}
