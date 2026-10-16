import type { ActivityLiveMessage } from "@hb/contracts";
import { useQueryClient } from "@tanstack/react-query";
import { useSetAtom } from "jotai";
import { useEffect } from "react";
import {
  activityKeys,
  nextPublicActivityReadGeneration,
  type PublicActivityDetail,
} from "./activities";
import { liveActivityAtom } from "./live-state";

// A running 红包's live channel (api: activities/live.ts). While a
// signed-in viewer has its page open, the 红包's own Durable Object pushes
// its public read after each change; the page's polling only backs it up.
// Guests, and anyone the channel turns away, poll as before.

/** Under Cloudflare's idle timeout; answered by the runtime, not the DO. */
const HEARTBEAT_MS = 30_000;
const PONG_WAIT_MS = 10_000;
const RETRY_FIRST_MS = 1_000;
const RETRY_LAST_MS = 30_000;
/** A connection that lasted this long starts the next wait over. */
const SETTLED_MS = 30_000;
/** The channel's own refusals: another tab took over, or it pushed the end. */
const FINAL_CODES = new Set([1000, 1008, 4001]);

/**
 * Keeps the 红包's live channel open while `enabled`: reconnects after a
 * drop (a deploy drops everyone at once, so the waits are spread out),
 * pauses while the page sits in the back-forward cache.
 */
export function useActivityLive(
  id: string,
  userId: string | null,
  enabled: boolean,
) {
  const client = useQueryClient();
  const setLive = useSetAtom(liveActivityAtom);
  useEffect(() => {
    if (!enabled || typeof WebSocket === "undefined") return;
    const url = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/activities/${encodeURIComponent(id)}/live`;
    const key = activityKeys.public(id, userId);
    let socket: WebSocket | null = null;
    let stopped = false;
    let paused = false;
    let attempts = 0;
    let retry: number | undefined;
    let heartbeat: number | undefined;
    let pongWait: number | undefined;
    const settle = () => {
      window.clearInterval(heartbeat);
      window.clearTimeout(pongWait);
      setLive((current) => (current === id ? null : current));
    };
    const connect = () => {
      if (stopped || paused) return;
      const ws = new WebSocket(url);
      socket = ws;
      let openedAt = 0;
      ws.onopen = () => {
        openedAt = Date.now();
        setLive(id);
        heartbeat = window.setInterval(() => {
          ws.send("ping");
          window.clearTimeout(pongWait);
          pongWait = window.setTimeout(() => ws.close(), PONG_WAIT_MS);
        }, HEARTBEAT_MS);
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
        if (stopped || paused || FINAL_CODES.has(event.code)) return;
        if (openedAt && Date.now() - openedAt > SETTLED_MS) attempts = 0;
        const wait =
          Math.min(RETRY_LAST_MS, RETRY_FIRST_MS * 2 ** attempts) *
          (0.5 + Math.random());
        attempts += 1;
        retry = window.setTimeout(connect, wait);
      };
    };
    const reconnectNow = () => {
      if (socket || stopped || paused) return;
      window.clearTimeout(retry);
      attempts = 0;
      connect();
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
    connect();
    return () => {
      stopped = true;
      window.removeEventListener("online", reconnectNow);
      window.removeEventListener("pagehide", onPageHide);
      window.removeEventListener("pageshow", onPageShow);
      window.clearTimeout(retry);
      socket?.close(1000);
      settle();
    };
  }, [id, userId, enabled, client, setLive]);
}
