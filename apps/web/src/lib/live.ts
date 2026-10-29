import type { ActivityLiveMessage } from "@hb/contracts";
import {
  type InfiniteData,
  type QueryClient,
  useQueryClient,
} from "@tanstack/react-query";
import { useSetAtom } from "jotai";
import { useEffect, useRef } from "react";
import {
  activityKeys,
  nextPublicActivityReadGeneration,
  type PublicActivityDetail,
} from "./activities";
import {
  ANNOUNCEMENTS_KEPT,
  liveActivityAtom,
  liveAnnouncementsAtom,
  liveJudgedAtom,
  liveViewAtom,
  liveViewersAtom,
  mergeAnnouncements,
  participationOpen,
  paymentOpen,
} from "./live-state";
import {
  type ParticipationCache,
  participationKey,
} from "./participation-cache";

// A 红包's live channel (api: activities/live.ts). While a signed-in viewer
// has its page open, the 红包's own Durable Object pushes its public read
// after each change, and says `mine` when only the viewer's own part moved
// (a payment; for the sender, their 名单 or their own edit elsewhere). The
// page then polls nothing; guests, and anyone the channel turns away, poll.

/** Under Cloudflare's idle timeout; answered by the runtime, not the DO. */
const HEARTBEAT_MS = 30_000;
const PONG_WAIT_MS = 10_000;
/** Back on the page: a line that does not answer by then is gone. */
const PROBE_WAIT_MS = 5_000;
const RETRY_FIRST_MS = 1_000;
const RETRY_LAST_MS = 30_000;
/** A connection that lasted this long starts the next wait over. */
const SETTLED_MS = 30_000;
/** The channel's own ends: the 红包 is over, push only, another tab took over. */
const FINAL_CODES = new Set([1000, 1008, 4001]);

/**
 * `running`: the 红包 runs, so its public read can change. `waiting`: it is
 * over, but a payment this person sees is still on its way.
 */
export type LiveWant = "running" | "waiting" | null;

type RosterPages = InfiniteData<{
  items: { payment?: { status: string } | null }[];
}>;

/** The viewer's own reads on the page: what `mine` reads again. */
function ownKeys(id: string, userId: string) {
  return {
    participation: participationKey(userId, id),
    roster: ["activity-roster", id, userId, "author"] as const,
    managed: activityKeys.detail(userId, id),
  };
}

/**
 * Reads the viewer's own part again. `onlyOpen`: just what can still move
 * (a payment on its way), for the gap between the page's reads and the
 * first connection.
 */
function readOwn(
  client: QueryClient,
  id: string,
  userId: string,
  onlyOpen: boolean,
) {
  const keys = ownKeys(id, userId);
  if (
    !onlyOpen ||
    participationOpen(
      client.getQueryData<ParticipationCache>(keys.participation),
    )
  )
    void client.invalidateQueries({
      queryKey: keys.participation,
      exact: true,
    });
  if (
    !onlyOpen ||
    client
      .getQueriesData<RosterPages>({ queryKey: keys.roster })
      .some(([, data]) =>
        data?.pages.some((page) =>
          page.items.some((item) => paymentOpen(item.payment)),
        ),
      )
  )
    void client.invalidateQueries({ queryKey: keys.roster });
  if (!onlyOpen)
    void client.invalidateQueries({ queryKey: keys.managed, exact: true });
}

/**
 * Keeps the 红包's live channel open while `want`: reconnects after a drop
 * (a deploy drops everyone at once, so the waits are spread out), checks
 * the line on coming back to the page, pauses while the page sits in the
 * back-forward cache.
 */
export function useActivityLive(
  id: string,
  userId: string | null,
  want: LiveWant,
) {
  const client = useQueryClient();
  const setLive = useSetAtom(liveActivityAtom);
  const setViewers = useSetAtom(liveViewersAtom);
  const setJudged = useSetAtom(liveJudgedAtom);
  const setView = useSetAtom(liveViewAtom);
  const setAnnounced = useSetAtom(liveAnnouncementsAtom);
  const wantNow = useRef(want);
  wantNow.current = want;
  const on = want !== null;
  useEffect(() => {
    if (!on || !userId || typeof WebSocket === "undefined") return;
    const url = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/activities/${encodeURIComponent(id)}/live`;
    const key = activityKeys.public(id, userId);
    let socket: WebSocket | null = null;
    let stopped = false;
    let paused = false;
    /** The channel ended it (FINAL_CODES): nothing more to connect for. */
    let finished = false;
    let attempts = 0;
    let opens = 0;
    /** When the current line opened. */
    let since = 0;
    let retry: number | undefined;
    let heartbeat: number | undefined;
    let pongWait: number | undefined;
    const settle = () => {
      window.clearInterval(heartbeat);
      window.clearTimeout(pongWait);
      setLive((current) => (current === id ? null : current));
      setViewers((current) => (current?.id === id ? null : current));
    };
    const retryLater = () => {
      if (since && Date.now() - since > SETTLED_MS) attempts = 0;
      const wait =
        Math.min(RETRY_LAST_MS, RETRY_FIRST_MS * 2 ** attempts) *
        (0.5 + Math.random());
      attempts += 1;
      retry = window.setTimeout(connect, wait);
    };
    /** A line that stopped answering: let it go now, not when the browser does. */
    const drop = (ws: WebSocket) => {
      ws.onopen = ws.onmessage = ws.onclose = null;
      try {
        ws.close();
      } catch {
        // Already closed.
      }
      if (socket !== ws) return;
      socket = null;
      settle();
      if (!stopped && !paused) retryLater();
    };
    const expectPong = (ws: WebSocket, wait: number) => {
      ws.send("ping");
      window.clearTimeout(pongWait);
      pongWait = window.setTimeout(() => drop(ws), wait);
    };
    const connect = () => {
      if (stopped || paused || finished) return;
      const ws = new WebSocket(url);
      socket = ws;
      since = 0;
      ws.onopen = () => {
        since = Date.now();
        setLive(id);
        // A reconnect may have missed a `mine`; the first connection, one
        // sent while the page read its own part.
        readOwn(client, id, userId, opens === 0);
        opens += 1;
        heartbeat = window.setInterval(
          () => expectPong(ws, PONG_WAIT_MS),
          HEARTBEAT_MS,
        );
      };
      ws.onmessage = (event) => {
        if (event.data === "pong") {
          window.clearTimeout(pongWait);
          return;
        }
        let message: ActivityLiveMessage;
        try {
          message = JSON.parse(String(event.data));
        } catch {
          return;
        }
        if (message?.type === "mine") {
          readOwn(client, id, userId, false);
          return;
        }
        if (message?.type === "viewers") {
          setViewers({ id, count: message.count });
          return;
        }
        if (message?.type === "judged") {
          setJudged({ id, count: message.count });
          return;
        }
        if (message?.type === "view") {
          setView({ id, view: message.view });
          return;
        }
        if (message?.type === "announce") {
          setAnnounced((current) => ({
            id,
            total: Math.max(
              message.total,
              current?.id === id ? current.total : 0,
            ),
            items: mergeAnnouncements(
              current?.id === id ? current.items : [],
              message.items,
            ).slice(0, ANNOUNCEMENTS_KEPT),
          }));
          return;
        }
        if (message?.type !== "activity" || !message.activity) return;
        // A poll already on its way could land after this, with older data.
        void client.cancelQueries({ queryKey: key, exact: true }).then(() =>
          client.setQueryData<PublicActivityDetail>(key, (previous) => ({
            activity: message.activity,
            readAt: Date.now(),
            readGeneration: nextPublicActivityReadGeneration(
              previous?.readGeneration ?? 0,
            ),
          })),
        );
      };
      ws.onclose = (event) => {
        if (socket === ws) socket = null;
        settle();
        if (stopped || paused) return;
        if (FINAL_CODES.has(event.code)) {
          finished = true;
          return;
        }
        // Over, and turned away: nothing it waited for is left. The page
        // reads its own part once instead.
        if (!since && wantNow.current === "waiting") {
          finished = true;
          readOwn(client, id, userId, false);
          return;
        }
        retryLater();
      };
    };
    const reconnectNow = () => {
      if (socket || stopped || paused || finished) return;
      window.clearTimeout(retry);
      attempts = 0;
      connect();
    };
    // Back on the page: the line may have died unnoticed while it was away.
    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      if (!socket) return reconnectNow();
      if (socket.readyState === WebSocket.OPEN)
        expectPong(socket, PROBE_WAIT_MS);
    };
    // An open socket keeps a page out of some browsers' back-forward cache.
    const onPageHide = () => {
      paused = true;
      window.clearTimeout(retry);
      socket?.close(1000);
    };
    const onPageShow = (event: PageTransitionEvent) => {
      if (!event.persisted) return;
      paused = false;
      reconnectNow();
    };
    window.addEventListener("online", reconnectNow);
    window.addEventListener("pagehide", onPageHide);
    window.addEventListener("pageshow", onPageShow);
    document.addEventListener("visibilitychange", onVisible);
    connect();
    return () => {
      stopped = true;
      window.removeEventListener("online", reconnectNow);
      window.removeEventListener("pagehide", onPageHide);
      window.removeEventListener("pageshow", onPageShow);
      document.removeEventListener("visibilitychange", onVisible);
      window.clearTimeout(retry);
      socket?.close(1000);
      settle();
      // Kept across a dropped line: a pushed count is never above the truth,
      // and the read alone may be older (a turn-down pushes nothing else).
      // So are the view and 动态 pushed with it.
      setJudged((current) => (current?.id === id ? null : current));
      setView((current) => (current?.id === id ? null : current));
      setAnnounced((current) => (current?.id === id ? null : current));
    };
  }, [
    id,
    userId,
    on,
    client,
    setLive,
    setViewers,
    setJudged,
    setView,
    setAnnounced,
  ]);
}
