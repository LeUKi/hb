import { useLocation, useMatches } from "@tanstack/react-router";
import { useAtomValue, useSetAtom } from "jotai";
import { AnimatePresence, motion, useIsPresent } from "motion/react";
import { type ReactNode, useEffect, useLayoutEffect, useRef } from "react";
import { activityIdFromCode, senderPages } from "../../lib/activity-route";
import { documentTitle } from "../../lib/brand";
import { type CommandId, commandById } from "../../lib/commands";
import { durations, ease, useReducedMotionPref } from "../../lib/motion";
import { topicAddress } from "../../lib/results";
import { pageTitleAtom, viewEdgeAtom } from "../../lib/store";
import { HelpView } from "../views/help-view";
import {
  CommandPageView,
  MessageView,
  MigratingView,
} from "../views/message-view";
import { ResultsView } from "../views/results-view";
import { StartView } from "../views/start-view";
import { StatusView } from "../views/status-view";
import { WindowClip } from "./window-clip";

type Leaf = ReturnType<typeof useLeaf>;

/** The command pages (帮助 has its own view; 登录 is not a page). */
const commandPages: Record<Exclude<CommandId, "help" | "login">, ReactNode> = {
  new: <MigratingView title="发红包" />,
  square: <MigratingView title="红包广场" />,
  history: <MigratingView title="红包记录" />,
  me: <MigratingView title="账号资料" />,
  merchant: <MigratingView title="LDC 商户配置" />,
  payments: <MigratingView title="付款记录" />,
  admin: <MigratingView title="网站管理" />,
};

function useLeaf() {
  return useMatches({ select: (matches) => matches[matches.length - 1] });
}

function renderView(leaf: NonNullable<Leaf>): ReactNode {
  const params = leaf.params as Record<string, string>;
  switch (leaf.routeId) {
    case "/":
      return <StartView />;
    case "/🧧/$code": {
      const id = activityIdFromCode(params.code ?? "");
      return id ? (
        <MigratingView title="红包" />
      ) : (
        <MessageView title="表情短地址无效" text="请检查链接是否完整。" />
      );
    }
    case "/🧧/$code/📝":
    case "/🧧/$code/📊":
    case "/🧧/$code/🧾": {
      const id = activityIdFromCode(params.code ?? "");
      const page = leaf.staticData.senderPage;
      return id && page ? (
        <MigratingView title={senderPages[page].title} />
      ) : (
        <MessageView title="表情短地址无效" text="请检查链接是否完整。" />
      );
    }
    case "/🔑/$resultId":
      return <ResultsView kind="redeem" resultId={params.resultId ?? ""} />;
    case "/💬/$topicId/$postNumber": {
      const topic = topicAddress(params.topicId ?? "", params.postNumber ?? "");
      return topic ? (
        <ResultsView kind="topic" {...topic} />
      ) : (
        <MessageView title="未找到页面" text="地址不存在或已经停用。" />
      );
    }
    case "/merchant/$merchantId":
      return (
        <CommandPageView
          id="merchant"
          page={<MigratingView title="商户详情" />}
        />
      );
    case "/payments/$paymentId":
      return (
        <CommandPageView
          id="payments"
          page={<MigratingView title="付款详情" />}
        />
      );
    case "/status":
      return <StatusView />;
    default: {
      const command = leaf.staticData.command;
      const subpage = leaf.staticData.subpage;
      if (command === "admin" && subpage)
        return (
          <CommandPageView
            id="admin"
            page={<MigratingView title={`网站管理 · ${subpage}`} />}
          />
        );
      if (command === "help") return <HelpView />;
      if (command && command !== "login")
        return <CommandPageView id={command} page={commandPages[command]} />;
      return <MessageView title="未找到页面" text="地址不存在或已经停用。" />;
    }
  }
}

/** Pages that draw from the window's top edge, under the 顶栏 (bleed). */
function bleeds(_leaf: NonNullable<Leaf>) {
  // The 红包 page bleeds; it comes with migration phase 2.
  return false;
}

function titleFor(leaf: NonNullable<Leaf>) {
  const senderPage = leaf.staticData.senderPage;
  if (senderPage) return documentTitle(senderPages[senderPage].title);
  if (leaf.routeId === "/🧧/$code") return documentTitle("红包");
  const { command, subpage } = leaf.staticData;
  // 网站管理's tabs say whose list it is (its 付款 is not your 付款记录).
  if (subpage)
    return documentTitle(
      command === "admin"
        ? `${commandById(command).title} · ${subpage}`
        : subpage,
    );
  if (command) return documentTitle(commandById(command).title);
  return documentTitle();
}

/** Scroll positions by history entry (this visit only). */
const scrolledTo = new Map<string, number>();
const scrollKeys = new Set([
  "ArrowUp",
  "ArrowDown",
  "PageUp",
  "PageDown",
  "Home",
  "End",
  " ",
]);

function ViewFrame({
  start,
  bleed,
  children,
}: {
  start: boolean;
  bleed: boolean;
  children: ReactNode;
}) {
  const present = useIsPresent();
  const reduced = useReducedMotionPref();
  const scroller = useRef<HTMLDivElement>(null);
  const setEdge = useSetAtom(viewEdgeAtom);
  // Each history entry keeps where its page was scrolled: Back to a list
  // lands where it was left. Not the 红包 page (bleed), which places its
  // cover by the scroll position itself, nor the start page.
  const locationKey = useLocation({
    select: (location) =>
      (location.state as { __TSR_key?: string }).__TSR_key ?? "",
  });
  const pathname = useLocation({ select: (location) => location.pathname });
  const entry = useRef({ key: locationKey, pathname });
  // A filter written into the address replaces the entry with a new key on
  // the same path: the page follows it and takes its position along. Any
  // other change is a navigation (the location moves before the next page
  // is committed), and this page keeps the entry it was shown in.
  if (
    present &&
    entry.current.key !== locationKey &&
    entry.current.pathname === pathname
  ) {
    const saved = scrolledTo.get(entry.current.key);
    if (saved !== undefined) scrolledTo.set(locationKey, saved);
    entry.current = { key: locationKey, pathname };
  }
  useLayoutEffect(() => {
    const element = scroller.current;
    if (!element || !entry.current.key || bleed || start) return;
    const saved = scrolledTo.get(entry.current.key) ?? 0;
    // The page may still be arriving (its data loading): until the saved
    // position fits, keep it and try again as the content changes. The
    // reader scrolling, or a few seconds, ends the wait.
    let waiting = saved > 0;
    const apply = () => {
      element.scrollTop = saved;
      if (element.scrollTop >= saved - 1) stop();
    };
    const observer = new MutationObserver(() => {
      if (waiting) apply();
    });
    const timer = window.setTimeout(() => stop(), 4000);
    function stop() {
      waiting = false;
      observer.disconnect();
      window.clearTimeout(timer);
    }
    // Scrolling by hand, not a press inside the page (重试 on a page that
    // failed to load must not lose the place): the scrollbar, scroll keys.
    const reader = (event: Event) => {
      if (event.type === "pointerdown" && event.target !== element) return;
      if (
        event instanceof KeyboardEvent &&
        (!scrollKeys.has(event.key) ||
          (event.target instanceof Element &&
            event.target.closest("input, textarea, select, button, a")))
      )
        return;
      stop();
    };
    const readerEvents = ["wheel", "touchmove", "keydown", "pointerdown"];
    if (waiting) {
      observer.observe(element, { childList: true, subtree: true });
      apply();
    } else stop();
    for (const name of readerEvents)
      element.addEventListener(name, reader, { passive: true });
    // Not while waiting: a clamped position is not where the reader was.
    const remember = () => {
      if (!waiting) scrolledTo.set(entry.current.key, element.scrollTop);
    };
    element.addEventListener("scroll", remember, { passive: true });
    return () => {
      stop();
      for (const name of readerEvents)
        element.removeEventListener(name, reader);
      element.removeEventListener("scroll", remember);
    };
  }, [bleed, start]);
  // The page on screen tells the 顶栏 what is beneath it; a leaving page
  // stops writing as soon as it starts to fade.
  useLayoutEffect(() => {
    if (!present) return;
    const element = scroller.current;
    const update = () => {
      // A 红包 page with its cover pinned under the bar is never "scrolled":
      // the bar sits on red either way, without a line across it.
      const scrolled =
        (element?.scrollTop ?? 0) > 0 &&
        !element?.querySelector(":scope > [data-cover-pinned]");
      setEdge((current) =>
        current.bleed === bleed && current.scrolled === scrolled
          ? current
          : { bleed, scrolled },
      );
    };
    update();
    element?.addEventListener("scroll", update, { passive: true });
    return () => element?.removeEventListener("scroll", update);
  }, [bleed, present, setEdge]);
  return (
    <motion.div
      ref={scroller}
      layoutScroll
      className={`view-scroll min-h-0 scroll-pt-(--bar-h) overflow-y-auto overscroll-y-contain pr-(--safe-right) pl-(--safe-left) [grid-area:stack] ${
        bleed ? "" : "pt-(--bar-h)"
      }`}
      style={{ pointerEvents: present ? "auto" : "none" }}
      initial={start ? { opacity: 0 } : { opacity: 0, y: reduced ? 0 : 14 }}
      animate={{
        opacity: 1,
        y: 0,
        transition: {
          duration: reduced ? 0 : durations.enter,
          delay: reduced ? 0 : start ? 0.04 : 0.1,
          ease,
        },
      }}
      exit={{
        opacity: 0,
        transition: { duration: reduced ? 0 : durations.exit },
      }}
    >
      {children}
    </motion.div>
  );
}

/** Route views stacked in one cell so entering and leaving views overlap. */
export function ViewStage() {
  const leaf = useLeaf();
  const pageTitle = useAtomValue(pageTitleAtom);
  useEffect(() => {
    if (leaf)
      document.title = pageTitle
        ? documentTitle(pageTitle.title)
        : titleFor(leaf);
  }, [leaf, pageTitle]);
  if (!leaf) return null;
  const start = leaf.routeId === "/";
  return (
    <WindowClip>
      <main
        id="view"
        tabIndex={-1}
        className="absolute inset-0 isolate grid grid-cols-[minmax(0,1fr)] grid-rows-[minmax(0,1fr)] outline-none [grid-template-areas:'stack']"
      >
        <AnimatePresence initial={false}>
          <ViewFrame key={leaf.id} start={start} bleed={bleeds(leaf)}>
            {renderView(leaf)}
          </ViewFrame>
        </AnimatePresence>
      </main>
    </WindowClip>
  );
}
