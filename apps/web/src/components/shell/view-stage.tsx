import { useLocation, useMatches } from "@tanstack/react-router";
import { useAtomValue, useSetAtom } from "jotai";
import { AnimatePresence, motion, useIsPresent } from "motion/react";
import { type ReactNode, useEffect, useLayoutEffect, useRef } from "react";
import { useActivityFacts } from "../../lib/activity-facts";
import { activityIdFromCode, senderPages } from "../../lib/activity-route";
import { documentTitle } from "../../lib/brand";
import { type CommandId, commandById } from "../../lib/commands";
import { durations, ease, useReducedMotionPref } from "../../lib/motion";
import { topicAddress } from "../../lib/results";
import { pageTitleAtom, viewEdgeAtom } from "../../lib/store";
import type { AdminSearch } from "../../router";
import { AdminActivities } from "../views/admin/admin-activities";
import { AdminAudit } from "../views/admin/admin-audit";
import { AdminBalance } from "../views/admin/admin-balance";
import { AdminArea } from "../views/admin/admin-frame";
import { AdminJudge } from "../views/admin/admin-judge";
import { AdminOverview } from "../views/admin/admin-overview";
import { AdminPayments } from "../views/admin/admin-payments";
import { AdminSettings } from "../views/admin/admin-settings";
import { AdminUsers } from "../views/admin/admin-users";
import { BalanceCheckoutView } from "../views/balance-checkout-view";
import { BalanceTopupView } from "../views/balance-topup-view";
import { BalanceView } from "../views/balance-view";
import { BalanceWithdrawalView } from "../views/balance-withdrawal-view";
import { DrawDataView } from "../views/draw-data-view";
import { HelpApiView } from "../views/help-api-view";
import { HelpCodeView } from "../views/help-code-view";
import { HelpPageView } from "../views/help-page-view";
import { HelpView } from "../views/help-view";
import { HistoryView } from "../views/history-view";
import { HongbaoView } from "../views/hongbao-view";
import { InviteView } from "../views/invite-view";
import { MeView } from "../views/me-view";
import { MerchantView } from "../views/merchant-view";
import { CommandPageView, MessageView } from "../views/message-view";
import { NewView } from "../views/new-view";
import { PaymentView } from "../views/payment-view";
import { PaymentsView } from "../views/payments-view";
import { RankView } from "../views/rank-view";
import { ResultsView } from "../views/results-view";
import { SenderView } from "../views/sender-view";
import { SquareView } from "../views/square-view";
import { StartView } from "../views/start-view";
import { StatusView } from "../views/status-view";
import { WindowClip } from "./window-clip";

type Leaf = ReturnType<typeof useLeaf>;

/** The command pages (帮助 has its own view; 登录 is not a page). */
const commandPages: Record<
  Exclude<CommandId, "help" | "login" | "admin">,
  ReactNode
> = {
  new: <NewView />,
  square: <SquareView />,
  rank: <RankView />,
  history: <HistoryView />,
  balance: <BalanceView />,
  me: <MeView />,
  merchant: <MerchantView />,
  payments: <PaymentsView />,
};

/**
 * 网站管理's pages, under one frame that stays (AdminArea). Their filters
 * come in as props from the match, like route params: a page that is leaving
 * keeps the search it was shown with instead of reading a route that is no
 * longer there.
 */
const adminPages: Record<string, (search: AdminSearch) => ReactNode> = {
  "/admin": () => <AdminOverview />,
  "/admin/activities": (search) => <AdminActivities search={search} />,
  "/admin/users": (search) => <AdminUsers search={search} />,
  "/admin/payments": (search) => <AdminPayments search={search} />,
  "/admin/balance": (search) => <AdminBalance search={search} />,
  "/admin/judge": () => <AdminJudge />,
  "/admin/settings": () => <AdminSettings />,
  "/admin/audit": () => <AdminAudit />,
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
        <HongbaoView id={id} />
      ) : (
        <MessageView title="红包地址不对" text="请检查链接是否完整。" />
      );
    }
    case "/🧧/$code/📝":
    case "/🧧/$code/📊":
    case "/🧧/$code/🧾": {
      const id = activityIdFromCode(params.code ?? "");
      const page = leaf.staticData.senderPage;
      return id && page ? (
        <SenderView id={id} page={page} />
      ) : (
        <MessageView title="红包地址不对" text="请检查链接是否完整。" />
      );
    }
    case "/🧧/$code/🎲": {
      const id = activityIdFromCode(params.code ?? "");
      return id ? (
        <DrawDataView id={id} />
      ) : (
        <MessageView title="红包地址不对" text="请检查链接是否完整。" />
      );
    }
    case "/invite/$token":
      return <InviteView token={params.token ?? ""} />;
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
          page={<MerchantView merchantId={params.merchantId ?? ""} />}
        />
      );
    case "/balance/$topupId":
      return (
        <CommandPageView
          id="balance"
          page={<BalanceTopupView id={params.topupId ?? ""} />}
        />
      );
    case "/balance/out/$withdrawalId":
      return (
        <CommandPageView
          id="balance"
          page={<BalanceWithdrawalView id={params.withdrawalId ?? ""} />}
        />
      );
    case "/balance/pay/$checkoutId":
      return (
        <CommandPageView
          id="balance"
          page={<BalanceCheckoutView id={params.checkoutId ?? ""} />}
        />
      );
    case "/payments/$paymentId":
      return (
        <CommandPageView
          id="payments"
          page={<PaymentView id={params.paymentId ?? ""} />}
        />
      );
    case "/status":
      return <StatusView />;
    case "/help/api":
      return <HelpApiView />;
    case "/help/code":
      return <HelpCodeView />;
    case "/help/page":
      return <HelpPageView />;
    default: {
      const command = leaf.staticData.command;
      const adminPage = adminPages[leaf.routeId];
      if (command === "admin" && adminPage)
        return (
          <CommandPageView
            id="admin"
            page={
              <AdminArea routeId={leaf.routeId}>
                {adminPage(leaf.search as AdminSearch)}
              </AdminArea>
            }
          />
        );
      if (command === "help") return <HelpView />;
      if (command && command !== "login" && command !== "admin")
        return <CommandPageView id={command} page={commandPages[command]} />;
      return <MessageView title="未找到页面" text="地址不存在或已经停用。" />;
    }
  }
}

/** The 红包 a route names, if any. */
function leafActivityId(leaf: Leaf) {
  const code = (leaf?.params as { code?: string } | undefined)?.code;
  return code ? activityIdFromCode(code) : null;
}

function titleFor(leaf: NonNullable<Leaf>, activityTitle: string | null) {
  const senderPage = leaf.staticData.senderPage;
  if (senderPage)
    return documentTitle(
      activityTitle
        ? `${senderPages[senderPage].title} · ${activityTitle}`
        : senderPages[senderPage].title,
    );
  if (leaf.routeId === "/🧧/$code")
    return documentTitle(activityTitle ?? "红包");
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
  lacquer,
  persistent,
  children,
}: {
  start: boolean;
  bleed: boolean;
  /** What bleeds is a 代码判定红包's black lacquer. */
  lacquer: boolean;
  /**
   * One frame for several routes (网站管理's tabs): it follows each entry
   * it shows, keeping each one's scroll position.
   */
  persistent: boolean;
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
    (entry.current.pathname === pathname || persistent)
  ) {
    if (entry.current.pathname === pathname) {
      const saved = scrolledTo.get(entry.current.key);
      if (saved !== undefined) scrolledTo.set(locationKey, saved);
    }
    entry.current = { key: locationKey, pathname };
  }
  // A frame that stays places each new path's entry where it was left.
  const placeFor = persistent ? entry.current.pathname : "";
  // biome-ignore lint/correctness/useExhaustiveDependencies: placeFor starts it over
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
    } else {
      // A frame that stays has the last tab's position: the new one starts
      // at the top.
      if (persistent) element.scrollTop = 0;
      stop();
    }
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
  }, [bleed, start, persistent, placeFor]);
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
        current.bleed === bleed &&
        current.lacquer === lacquer &&
        current.scrolled === scrolled
          ? current
          : { bleed, lacquer, scrolled },
      );
    };
    update();
    element?.addEventListener("scroll", update, { passive: true });
    return () => element?.removeEventListener("scroll", update);
  }, [bleed, lacquer, present, setEdge]);
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
  // The 红包 the route names, as its page has read it.
  const activity = useActivityFacts(leafActivityId(leaf));
  const activityTitle = activity?.title ?? null;
  useEffect(() => {
    if (leaf)
      document.title = pageTitle
        ? documentTitle(pageTitle.title)
        : titleFor(leaf, activityTitle);
  }, [leaf, pageTitle, activityTitle]);
  if (!leaf) return null;
  const start = leaf.routeId === "/";
  const admin = leaf.staticData.command === "admin";
  return (
    <WindowClip>
      <main
        id="view"
        tabIndex={-1}
        className="absolute inset-0 isolate grid grid-cols-[minmax(0,1fr)] grid-rows-[minmax(0,1fr)] outline-none [grid-template-areas:'stack']"
      >
        <AnimatePresence initial={false}>
          {/* The 红包 page draws from the window's top edge, under the 顶栏,
              once it has its 红包 to draw. */}
          {/* 网站管理 keeps one frame for its tabs (AdminArea). */}
          <ViewFrame
            key={admin ? "admin" : leaf.id}
            start={start}
            bleed={leaf.routeId === "/🧧/$code" && activity !== null}
            lacquer={leaf.routeId === "/🧧/$code" && Boolean(activity?.code)}
            persistent={admin}
          >
            {renderView(leaf)}
          </ViewFrame>
        </AnimatePresence>
      </main>
    </WindowClip>
  );
}
