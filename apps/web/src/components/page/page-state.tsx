import type { UseQueryResult } from "@tanstack/react-query";
import { CloudOff, RotateCw, Wrench } from "lucide-react";
import { motion, useIsPresent } from "motion/react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { cn } from "../../lib/cn";
import { useMaintenance } from "../../lib/maintenance";
import { ease, useReducedMotionPref } from "../../lib/motion";
import { Button } from "../ui/button";
import { Swap } from "../ui/reveal";
import { Squircle } from "../ui/squircle";
import { Page, Panel, RefreshContext } from "./page";

// How a page's data arrives: every page reads from the API, so it has a
// first load, a failed first load, and a background refresh that can fail
// while the old content stays (07 §1). The page's queries drive all three.

/** What a page knows about its data, from one query or several. */
export type Loadable = {
  /** Everything the page needs is in. */
  hasData: boolean;
  /** The last read failed. */
  isError: boolean;
  /** A read is on its way. */
  isFetching: boolean;
  /** Reads again; resolves to whether that worked. */
  refetch: () => Promise<boolean>;
};

/**
 * The last read failed — not only a list's next batch, which its end row
 * reports (重试加载) without calling the page stale.
 */
export function readFailed(query: {
  isError: boolean;
  isFetchNextPageError?: boolean;
}) {
  return query.isError && !query.isFetchNextPageError;
}

/** One query as a Loadable. */
export function queryLoad(query: UseQueryResult<unknown>): Loadable {
  return {
    hasData: query.data !== undefined,
    isError: readFailed(query),
    isFetching: query.isFetching,
    refetch: async () => !(await query.refetch()).isError,
  };
}

/** Several queries the page needs together. */
export function queriesLoad(...queries: UseQueryResult<unknown>[]): Loadable {
  return {
    hasData: queries.every((query) => query.data !== undefined),
    isError: queries.some(readFailed),
    isFetching: queries.some((query) => query.isFetching),
    refetch: async () =>
      (await Promise.all(queries.map((query) => query.refetch()))).every(
        (result) => !result.isError,
      ),
  };
}

/** A grey bar standing in for text while a page loads (squircle ends). */
export function Bone({
  className,
  radius = 4,
  red = false,
}: {
  className: string;
  radius?: number;
  /** On the red cover (cream instead of grey). */
  red?: boolean;
}) {
  return (
    <Squircle radius={radius}>
      <span
        className={cn("skeleton block", red && "skeleton-red", className)}
      />
    </Squircle>
  );
}

/** The first load: the page's frame with grey bars where the text goes. */
export function PageSkeleton({ focus = false }: { focus?: boolean }) {
  // After 重试 the button is gone: focus stays here, reading 正在读取….
  const status = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    if (focus) status.current?.focus({ preventScroll: true });
  }, [focus]);
  return (
    <Page>
      <p
        ref={status}
        role="status"
        tabIndex={-1}
        className="sr-only outline-none"
      >
        正在读取…
      </p>
      <div aria-hidden="true" className="grid gap-6 @wide/window:gap-8">
        <div className="grid gap-2.5 px-1">
          <Bone className="h-6 w-36" radius={7} />
          <Bone className="h-3.5 w-64 max-w-full" />
        </div>
        {[0, 1].map((panel) => (
          <Panel key={panel} className="grid gap-3.5 p-5">
            <Bone className="h-4 w-28" radius={5} />
            <Bone className="h-3 w-full" />
            <Bone className="h-3 w-5/6" />
            <Bone className="h-3 w-2/3" />
          </Panel>
        ))}
      </div>
    </Page>
  );
}

/** Rows of grey bars where a list's rows go, in its panel. */
export function ListSkeleton({ rows = 4 }: { rows?: number }) {
  return (
    <Panel className="grid gap-0.5 p-1.5">
      <div aria-hidden="true" className="grid gap-0.5">
        {Array.from({ length: rows }, (_, row) => row).map((row) => (
          <div key={row} className="flex items-center gap-3.5 p-3">
            <Bone className="size-10 shrink-0" radius={10} />
            <div className="grid flex-1 gap-2">
              <Bone
                className={cn("h-4", row % 2 ? "w-1/3" : "w-2/5")}
                radius={5}
              />
              <Bone className={cn("h-3", row % 2 ? "w-1/2" : "w-3/5")} />
            </div>
          </div>
        ))}
      </div>
    </Panel>
  );
}

/** A part of a page loading for the first time (its frame stays). */
function AreaSkeleton({ focus = false }: { focus?: boolean }) {
  const status = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    if (focus) status.current?.focus({ preventScroll: true });
  }, [focus]);
  return (
    <div className="grid gap-6 @wide/window:gap-8">
      <p
        ref={status}
        role="status"
        tabIndex={-1}
        className="sr-only outline-none"
      >
        正在读取…
      </p>
      <ListSkeleton />
    </div>
  );
}

/** A part of a page could not be read: say so there, with 重试. */
export function ResultError({ onRetry }: { onRetry: () => void }) {
  const maintenance = useMaintenance();
  const Icon = maintenance ? Wrench : CloudOff;
  return (
    <Panel className="grid justify-items-center gap-3 px-6 py-10 text-center">
      <Icon className="size-5 text-ink-3" aria-hidden="true" />
      <div role="alert" className="grid gap-1">
        <p className="text-base font-medium text-ink">
          {maintenance ? "系统维护中" : "读取失败"}
        </p>
        <p className="text-sm text-ink-3">
          {maintenance
            ? "维护结束后会自己恢复。"
            : "网络或服务暂时出了问题，稍后再试。"}
        </p>
      </div>
      <Button size="sm" variant="ghost" onClick={onRetry}>
        <RotateCw aria-hidden="true" />
        重试
      </Button>
    </Panel>
  );
}

/** A list's query as ResultLoad reads it. */
export function resultOf(query: {
  data: unknown;
  isPlaceholderData: boolean;
  isError: boolean;
  isFetchNextPageError?: boolean;
  refetch: () => Promise<unknown>;
}) {
  return {
    hasData: query.data !== undefined,
    placeholder: query.isPlaceholderData,
    isError: readFailed(query),
    retry: () => void query.refetch(),
  };
}

/**
 * The part of a page that shows a list, under the switchers that choose
 * it (the frame stays). A new choice of the same list keeps the old rows,
 * dimmed, until the new ones are in; a list never read before shows bars
 * there; a failed read says so there. Each change fades in place (Swap),
 * `id` naming what is shown.
 */
export function ResultLoad({
  id,
  load,
  skeleton,
  className,
  children,
}: {
  id: string;
  load: ReturnType<typeof resultOf>;
  skeleton?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  const kind = load.hasData
    ? load.placeholder
      ? "stale"
      : "ready"
    : load.isError
      ? "error"
      : "loading";
  // The old rows stay under the id they were read for.
  const readyId = useRef(id);
  if (kind === "ready") readyId.current = id;
  const swapId =
    kind === "ready"
      ? `ready:${id}`
      : kind === "stale"
        ? `ready:${readyId.current}`
        : kind;
  return (
    <Swap id={swapId}>
      {kind === "loading" ? (
        <>
          <p role="status" className="sr-only">
            正在读取…
          </p>
          {skeleton ?? <ListSkeleton />}
        </>
      ) : kind === "error" ? (
        <ResultError onRetry={load.retry} />
      ) : (
        <div
          aria-busy={kind === "stale" || undefined}
          className={cn(
            "grid gap-6 transition-opacity duration-200 @wide/window:gap-8",
            kind === "stale" && "opacity-60",
            className,
          )}
        >
          {children}
        </div>
      )}
    </Swap>
  );
}

/** The first load failed: nothing to show yet, so say so and offer a retry. */
export function LoadError({ onRetry }: { onRetry: () => void }) {
  // 维护模式 (lib/maintenance.ts): the page reads again by itself after.
  const maintenance = useMaintenance();
  const Icon = maintenance ? Wrench : CloudOff;
  return (
    <div className="flex min-h-full flex-col items-center justify-center gap-5 px-6 py-10 text-center">
      <Squircle radius={18}>
        <span className="grid size-14 place-items-center bg-fill text-ink-2 shadow-[inset_0_1px_0_rgb(255_255_255/0.7)]">
          <Icon className="size-6" aria-hidden="true" />
        </span>
      </Squircle>
      {/* The alert is the words; the button is read as itself. */}
      <div role="alert" className="grid gap-1.5">
        <h1 className="text-xl font-semibold text-ink">
          {maintenance ? "系统维护中" : "读取失败"}
        </h1>
        <p className="text-base text-ink-2">
          {maintenance
            ? "请稍后再试，维护结束后页面会自己恢复。"
            : "网络或服务暂时出了问题，稍后再试。"}
        </p>
      </div>
      <Button variant="primary" onClick={onRetry}>
        <RotateCw aria-hidden="true" />
        重试
      </Button>
    </div>
  );
}

/**
 * A page's data as three states: the first load (loading → ready), a failed
 * one (error, with 重试 → loading), a failed background refresh (stale, with
 * 重试). After a 重试 that worked, focus goes to the page's title — found
 * with `title()` — if it is still where the button left it, and the change
 * is said.
 */
export function usePageLoad(
  load: Loadable,
  title: () => HTMLElement | null | undefined,
  frame?: Loadable | true,
) {
  // Once shown, a page with a frame keeps it: a new filter's list loads in
  // its own place (ResultLoad), not by turning the page back into bars.
  const [shown, setShown] = useState(load.hasData);
  if (load.hasData && !shown) setShown(true);
  const gate = shown && frame ? (frame === true ? null : frame) : load;
  const state =
    gate === null || gate.hasData
      ? "ready"
      : gate.isError
        ? "error"
        : "loading";
  // Content that arrives after a skeleton fades in over it.
  const [loaded] = useState(() => !load.hasData);
  const [retried, setRetried] = useState(false);
  const [said, setSaid] = useState("");
  const [rereading, setRereading] = useState(false);
  // 刷新 by hand keeps focus on its button (it stays); 重试 does not.
  const manual = useRef(false);
  const latestTitle = useRef(title);
  latestTitle.current = title;
  const present = useIsPresent();
  useEffect(() => {
    if (state !== "ready" || !(retried || said) || !present) return;
    if (manual.current) {
      manual.current = false;
      return;
    }
    const target = latestTitle.current();
    // Only if focus is still where 重试 left it (the page, or nowhere):
    // someone who moved on, say into the 指令框, keeps their place.
    const active = document.activeElement;
    const page = target?.closest(".view-scroll");
    if (active && active !== document.body && !page?.contains(active)) return;
    target?.focus({ preventScroll: true });
  }, [state, retried, said, present]);
  const reread = (byHand: boolean) => {
    if (rereading) return;
    manual.current = byHand;
    setRereading(true);
    void load.refetch().then((ok) => {
      setRereading(false);
      // A new string each time, so a second 刷新 is said again.
      if (ok)
        setSaid((current) => (current === "已刷新" ? "已刷新。" : "已刷新"));
    });
  };
  return {
    state,
    loaded,
    /** The skeleton after 重试 holds focus. */
    retried,
    said,
    refresh: {
      stale: load.hasData && load.isError && !rereading,
      retrying: rereading,
      retry: () => reread(false),
      reload: () => reread(true),
    },
    retryLoad: () => {
      setRetried(true);
      void load.refetch();
    },
  };
}

/**
 * A page around its data: skeleton, error, or the page (maybe stale).
 * `frame`: what the page's frame (title, switchers) needs once it has been
 * shown — the rest, its list, then loads in place (ResultLoad); `true`
 * when the frame needs nothing. `area`: the load fills a part of a page
 * whose frame is drawn around it (网站管理's tabs), not a whole page.
 */
export function PageLoad({
  load: loadable,
  frame,
  area = false,
  children,
}: {
  load: Loadable;
  frame?: Loadable | true;
  area?: boolean;
  children: ReactNode;
}) {
  const content = useRef<HTMLDivElement>(null);
  const reduced = useReducedMotionPref();
  const load = usePageLoad(
    loadable,
    () => content.current?.querySelector<HTMLElement>("h1[tabindex]"),
    frame,
  );
  if (load.state === "loading")
    return area ? (
      <AreaSkeleton focus={load.retried} />
    ) : (
      <PageSkeleton focus={load.retried} />
    );
  if (load.state === "error")
    return area ? (
      <ResultError onRetry={load.retryLoad} />
    ) : (
      <LoadError onRetry={load.retryLoad} />
    );
  return (
    <RefreshContext.Provider value={load.refresh}>
      <p role="status" className="sr-only">
        {load.said}
      </p>
      <div ref={content} className="contents">
        {/* Content that arrives after a skeleton fades in over it. */}
        {load.loaded ? (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: reduced ? 0 : 0.24, ease }}
          >
            {children}
          </motion.div>
        ) : (
          children
        )}
      </div>
    </RefreshContext.Provider>
  );
}
