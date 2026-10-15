import { useAtomValue } from "jotai";
import { CloudOff, RotateCw } from "lucide-react";
import { motion, useIsPresent } from "motion/react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { cn } from "../../lib/cn";
import { ease, useReducedMotionPref } from "../../lib/motion";
import { pageLoadSimAtom } from "../../lib/store";
import { Button } from "../ui/button";
import { Squircle } from "../ui/squircle";
import { Page, Panel, RefreshContext } from "./page";

// How a page's data arrives: production reads each page from the API, so
// every page has a first load, a failed first load, and a background refresh
// that can fail while the old content stays. The dev toolbar's 页面数据
// switch plays each one (the prototype's data is local and instant).

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

/** The first load failed: nothing to show yet, so say so and offer a retry. */
export function LoadError({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="flex min-h-full flex-col items-center justify-center gap-5 px-6 py-10 text-center">
      <Squircle radius={18}>
        <span className="grid size-14 place-items-center bg-fill text-ink-2 shadow-[inset_0_1px_0_rgb(255_255_255/0.7)]">
          <CloudOff className="size-6" aria-hidden="true" />
        </span>
      </Squircle>
      {/* The alert is the words; the button is read as itself. */}
      <div role="alert" className="grid gap-1.5">
        <h1 className="text-xl font-semibold text-ink">读取失败</h1>
        <p className="text-base text-ink-2">
          网络或服务暂时出了问题，稍后再试。
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
 * The 页面数据 switch as a state machine: a first load (loading → ready),
 * a failed one (error, with 重试 → loading), a failed background refresh
 * (stale, with 重试). After a 重试 that worked, focus goes to the page's
 * title — found with `title()` — if it is still where the button left it,
 * and the change is said.
 */
export function usePageLoad(title: () => HTMLElement | null | undefined) {
  const sim = useAtomValue(pageLoadSimAtom);
  const [state, setState] = useState<"loading" | "error" | "ready">(() =>
    sim === "slow" ? "loading" : sim === "error" ? "error" : "ready",
  );
  const [stale, setStale] = useState(sim === "stale");
  const [retrying, setRetrying] = useState(false);
  const [loaded, setLoaded] = useState(sim === "slow");
  const [retried, setRetried] = useState(false);
  const [said, setSaid] = useState("");
  // 刷新 by hand keeps focus on its button (it stays); 重试 does not.
  const manual = useRef(false);
  const latestTitle = useRef(title);
  latestTitle.current = title;
  useEffect(() => {
    if (state !== "loading") return;
    const timer = window.setTimeout(() => setState("ready"), 1200);
    return () => window.clearTimeout(timer);
  }, [state]);
  useEffect(() => {
    if (!retrying) return;
    const timer = window.setTimeout(() => {
      setRetrying(false);
      setStale(false);
      // A new string each time, so a second 刷新 is said again.
      setSaid((current) => (current === "已刷新" ? "已刷新。" : "已刷新"));
    }, 900);
    return () => window.clearTimeout(timer);
  }, [retrying]);
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
  return {
    state,
    /** Arrived after a skeleton: fade it in. */
    loaded,
    /** The skeleton after 重试 holds focus. */
    retried,
    said,
    refresh: {
      stale,
      retrying,
      retry: () => {
        manual.current = false;
        setRetrying(true);
      },
      reload: () => {
        manual.current = true;
        setRetrying(true);
      },
    },
    retryLoad: () => {
      setLoaded(true);
      setRetried(true);
      setState("loading");
    },
  };
}

/** Plays the 页面数据 switch around a page: skeleton, error or stale. */
export function PageLoad({ children }: { children: ReactNode }) {
  const content = useRef<HTMLDivElement>(null);
  const reduced = useReducedMotionPref();
  const load = usePageLoad(() =>
    content.current?.querySelector<HTMLElement>("h1[tabindex]"),
  );
  if (load.state === "loading") return <PageSkeleton focus={load.retried} />;
  if (load.state === "error") return <LoadError onRetry={load.retryLoad} />;
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
