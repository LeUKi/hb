import { RotateCw } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { cn } from "../../lib/cn";
import { Button } from "../ui/button";
import { Spinner } from "../ui/kbd";
import { MorphLabel } from "../ui/morph-label";

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
  /** Another filter's rows, shown while this one's load: never extended. */
  isPlaceholderData?: boolean;
}): LazyList {
  const [end, setEnd] = useState<HTMLElement | null>(null);
  const { fetchNextPage } = query;
  const load = useCallback(() => void fetchNextPage(), [fetchNextPage]);
  const state =
    !query.hasNextPage || query.isPlaceholderData
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
            variant="quiet"
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
        <>
          {/* Said from a region that stays; shown as a cross-fade. */}
          <span aria-live="polite" className="sr-only">
            {state === "done" ? done : "正在加载…"}
          </span>
          <span aria-hidden="true" className="grid">
            <MorphLabel fit={false}>
              {state === "done" ? (
                done
              ) : (
                <span className="flex items-center gap-2">
                  <Spinner />
                  正在加载…
                </span>
              )}
            </MorphLabel>
          </span>
        </>
      )}
    </div>
  );
}
