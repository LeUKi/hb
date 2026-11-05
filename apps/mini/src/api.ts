import type {
  ClaimResult,
  CreateTipInput,
  MiniClaimInput,
  MiniHongbaoResponse,
  MiniLiveMessage,
  MiniRosterKind,
  MiniRosterPage,
  Tip,
  TipCard,
  TipCardView,
  TipList,
  TipResult,
} from "@hb/contracts";
import { useEffect, useRef } from "react";
import type { MiniSdk, MiniSocket } from "./sdk";

// 红包站's mini app routes (docs/mini-app-design.md §7), through the SDK:
// the endpoints are manifest.json's, each request signed by the forum.

/** 红包站's answer when it says no, in its own words. */
export class HongbaoError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** The SDK's own failures (no network, a timeout) in plain words. */
function sdkError(error: unknown): HongbaoError {
  const code = (error as { code?: string } | null)?.code ?? "NETWORK";
  return new HongbaoError(
    0,
    code,
    code === "TIMEOUT"
      ? "红包站没有及时回答，请再试一次。"
      : code === "PERMISSION_DENIED" || code === "ACCESS_DENIED"
        ? "社区没有允许这个小程序联网。"
        : "连不上红包站，请再试一次。",
  );
}

async function call<T>(
  sdk: MiniSdk,
  endpoint: string,
  options: { query?: Record<string, string>; json?: unknown },
): Promise<T> {
  let response: Awaited<ReturnType<MiniSdk["http"]["request"]>>;
  try {
    response = await sdk.http.request(endpoint, options);
  } catch (error) {
    throw sdkError(error);
  }
  if (response.status >= 200 && response.status < 300)
    return response.body as T;
  const error = (
    response.body as { error?: { code?: string; message?: string } } | null
  )?.error;
  throw new HongbaoError(
    response.status,
    error?.code ?? `HTTP_${response.status}`,
    error?.message ?? "红包站出了点问题，请再试一次。",
  );
}

export const readHongbao = (sdk: MiniSdk, id: string) =>
  call<MiniHongbaoResponse>(sdk, "hongbao", { query: { id } });

export const claimHongbao = (sdk: MiniSdk, id: string, input: MiniClaimInput) =>
  call<ClaimResult>(sdk, "claim", { query: { id }, json: input });

export const readRoster = (
  sdk: MiniSdk,
  id: string,
  kind: MiniRosterKind,
  cursor: string | null,
) =>
  call<MiniRosterPage>(sdk, "roster", {
    query: { id, kind, ...(cursor ? { cursor } : {}) },
  });

/** The forum closes a connection at 300 s: the next one opens before. */
const RENEW_MS = 270_000;
/** Closed by the 红包's object for good: ended, push only, replaced. */
const FINAL_CODES = new Set([1000, 1008, 4001]);

/**
 * The 红包's live channel while `on`: each connection lives at most 300 s,
 * so the next opens a little before and the old one closes once it is up
 * (the forum allows two); a lost one comes back after a pause. One that
 * cannot connect (over since, say) asks for a fresh read (`onLost`).
 * Gives whether a connection is up now.
 */
export function useLive(
  sdk: MiniSdk,
  id: string,
  on: boolean,
  onMessage: (message: MiniLiveMessage) => void,
  onLost: () => void,
) {
  const listener = useRef(onMessage);
  listener.current = onMessage;
  const lost = useRef(onLost);
  lost.current = onLost;
  const up = useRef(false);
  useEffect(() => {
    if (!on) return;
    let stopped = false;
    let current: MiniSocket | null = null;
    let renew: ReturnType<typeof setTimeout> | undefined;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let failures = 0;
    const open = async () => {
      if (stopped) return;
      let socket: MiniSocket;
      try {
        socket = await sdk.webSocket.connect("live", { query: { id } });
        await socket.ready;
      } catch {
        failures += 1;
        lost.current();
        retry = setTimeout(open, Math.min(30_000, 2_000 * 2 ** (failures - 1)));
        return;
      }
      if (stopped) {
        void socket.close();
        return;
      }
      failures = 0;
      const previous = current;
      current = socket;
      up.current = true;
      socket.on("message", (value) =>
        listener.current(value as MiniLiveMessage),
      );
      socket.on("close", ({ code }) => {
        if (stopped || current !== socket) return;
        current = null;
        up.current = false;
        clearTimeout(renew);
        // Its own ends, as 红包站's page (lib/live.ts FINAL_CODES): over,
        // push only, or another of theirs took its place. Read it once and
        // stay off; coming back would close another (an endless ring).
        if (FINAL_CODES.has(code)) return lost.current();
        // Anything else (a deploy): back, spread over a few seconds so not
        // every page in the 社区 comes at once.
        retry = setTimeout(open, 1_000 + Math.random() * 2_000);
      });
      if (previous) void previous.close().catch(() => {});
      clearTimeout(renew);
      renew = setTimeout(open, RENEW_MS);
    };
    void open();
    return () => {
      stopped = true;
      up.current = false;
      clearTimeout(renew);
      clearTimeout(retry);
      void current?.close().catch(() => {});
    };
  }, [sdk, id, on]);
  return up;
}

// 打赏 (docs/tip-design.md §5, §7): a card, a tip on it, “查一下”, and the
// app's home (one's own cards).

export type MiniTipView = TipCardView & { lookOnly: boolean };

export type MiniTipsHome = {
  known: boolean;
  cards: TipCard[];
  used: number;
  limit: number;
  enabled: boolean;
  received: Tip[];
  week?: TipList["stats"];
};

export const readTip = (sdk: MiniSdk, code: string) =>
  call<MiniTipView>(sdk, "tip", { query: { id: code } });

export const createTip = (
  sdk: MiniSdk,
  code: string,
  input: CreateTipInput & {
    forumUser?: { username: string; name: string };
  },
) => call<TipResult>(sdk, "tipCreate", { query: { id: code }, json: input });

export const checkTip = (sdk: MiniSdk, code: string, tip: string) =>
  call<TipResult>(sdk, "tipCheck", { query: { id: code, tip } });

export const readTipsHome = (sdk: MiniSdk) =>
  call<MiniTipsHome>(sdk, "tipsHome", {});
