import { useLocation } from "@tanstack/react-router";
import { useAtomValue } from "jotai";
import { RotateCw } from "lucide-react";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { cn } from "../../lib/cn";
import { pageLoadSimAtom } from "../../lib/store";
import { Button } from "../ui/button";
import { Spinner } from "../ui/kbd";

/** How many rows a batch adds (production reads 20 at a time). */
export const PAGE_SIZE = 20;

const batchMs = 500;

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

/**
 * A list that loads its next 20 rows as its end comes near (600px before
 * it shows), in whatever scrolls it: the page, or a dialog's own list. The
 * prototype has every row already, so a batch only waits a moment; the
 * toolbar's 页面数据 → 加载更多失败 fails one batch, to show 重试加载.
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
  const failing = useAtomValue(pageLoadSimAtom) === "more-error";
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

  const [state, setState] = useState<"idle" | "loading" | "failed">("idle");
  const failed = useRef(false);
  const [end, setEnd] = useState<HTMLElement | null>(null);
  const more = shown < total;

  const load = useCallback(() => {
    setState("loading");
  }, []);

  useEffect(() => {
    if (state !== "loading") return;
    const timer = window.setTimeout(() => {
      if (failing && !failed.current) {
        failed.current = true;
        setState("failed");
        return;
      }
      setList((current) => ({ ...current, shown: current.shown + pageSize }));
      setState("idle");
    }, batchMs);
    return () => window.clearTimeout(timer);
  }, [state, failing, pageSize]);

  // Observed again after every batch (a new `shown`): a short list whose
  // end is still in reach keeps filling itself.
  useEffect(() => {
    if (!end || shown >= total || state !== "idle") return;
    const root = end.closest(".view-scroll");
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((item) => item.isIntersecting)) load();
      },
      { root, rootMargin: "0px 0px 600px 0px" },
    );
    observer.observe(end);
    return () => observer.disconnect();
  }, [end, shown, total, state, load]);

  return {
    shown: Math.min(shown, total),
    endRef: setEnd,
    state: !more
      ? "done"
      : state === "idle"
        ? "more"
        : state === "loading"
          ? "loading"
          : "failed",
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
  if (!list.paged) return null;
  return (
    <div
      ref={list.endRef}
      className={cn(
        "flex min-h-11 items-center justify-center gap-2 px-3 text-sm text-ink-3",
        className,
      )}
    >
      {list.state === "failed" ? (
        <>
          <span role="alert">后续记录读取失败，可重试加载。</span>
          <Button size="sm" variant="ghost" onClick={list.retry}>
            <RotateCw aria-hidden="true" />
            重试加载
          </Button>
        </>
      ) : (
        <span aria-live="polite" className="flex items-center gap-2">
          {list.state === "done" ? (
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
