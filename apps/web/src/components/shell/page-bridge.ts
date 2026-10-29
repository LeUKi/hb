import type {
  JudgeAnnouncement,
  JudgeView,
  MyJudgmentList,
  PublicActivity,
} from "@hb/contracts";
import { skipToken, useQuery } from "@tanstack/react-query";
import { useAtomValue } from "jotai";
import { type RefObject, useEffect, useRef } from "react";
import {
  activityKeys,
  type PublicActivityDetail,
  readResponse,
} from "../../lib/activities";
import { activityPath, useCurrentActivityId } from "../../lib/activity-route";
import { liveJudgedAtom } from "../../lib/live-state";
import { notJudged } from "../../lib/page-submit";
import { useSessionUser } from "../../lib/session";
import { useJudgeBoard } from "../hongbao/judge-board";
import { useOmniboxController } from "../omnibox/use-omnibox-controller";

// 附带网页 SDK (docs/judge-page-design.md §3, §11.8): what /sdk/v1.js in
// the page beside a 红包 asks, answered over postMessage. Only that frame
// is heard, and only from the address it was given; what is sent goes to
// that address only. Pushes start once the page has said hello.

/** What the SDK says of a 红包 (hongbao). */
function hongbaoOf(activity: PublicActivity, judged: number | null) {
  const quantity = activity.quantity;
  return {
    id: activity.id,
    title: activity.title,
    url: `${window.location.origin}${activityPath(activity.id)}`,
    code: activity.participationMode === "code",
    status: activity.status === "archived" ? "ended" : activity.status,
    endedByCode: activity.judge?.endedByCode === true,
    unit: activity.funding === "balance" ? "🐟" : "LDC",
    shares:
      quantity.mode === "exact"
        ? {
            total: quantity.total,
            claimed: quantity.claimed,
            remaining: quantity.remaining,
          }
        : null,
    pool: activity.reward?.totalAmount ?? null,
    deadlineAt: activity.draw?.deadlineAt ?? activity.deadlineAt,
    judged,
  };
}

const viewOf = (view: JudgeView | undefined) =>
  view
    ? { summary: view.summary ?? null, data: view.data ?? null, at: view.at }
    : null;

const lineOf = (line: JudgeAnnouncement) => ({
  n: line.n,
  at: line.at,
  user: { name: line.user.displayName, avatar: line.user.avatarUrl },
  text: line.text,
});

/** The viewer's own submissions, as `hb.mine()` gives them. */
async function readMine(activityId: string, next: string | null) {
  const list = await readResponse<MyJudgmentList>(
    await fetch(
      `/api/activities/${encodeURIComponent(activityId)}/judgments${next ? `?cursor=${encodeURIComponent(next)}` : ""}`,
      { cache: "no-store" },
    ),
  );
  return {
    total: list.total,
    items: list.items.map((item) => ({
      n: item.attempt,
      at: item.at,
      input: item.input,
      claimed: item.amount !== undefined,
      ...(item.amount !== undefined ? { amount: item.amount } : {}),
      ...(item.message ? { reply: item.message } : {}),
    })),
    next: list.nextCursor,
  };
}

type Ask =
  | { hb: 1; id: number; type: "hello" }
  | { hb: 1; id: number; type: "submit"; input: string }
  | { hb: 1; id: number; type: "mine"; next: string | null };

function askOf(data: unknown): Ask | null {
  if (typeof data !== "object" || data === null) return null;
  const ask = data as Record<string, unknown>;
  if (ask.hb !== 1 || !Number.isSafeInteger(ask.id)) return null;
  if (ask.type === "hello") return ask as Ask;
  // Longer than any answer could be: not worth reading.
  if (
    ask.type === "submit" &&
    typeof ask.input === "string" &&
    ask.input.length <= 4000
  )
    return ask as Ask;
  if (
    ask.type === "mine" &&
    (ask.next === null ||
      (typeof ask.next === "string" && ask.next.length < 200))
  )
    return ask as Ask;
  return null;
}

/**
 * Answers the page in `frame` (at `url`, the 附带网页 of `activityId`):
 * hello with the 红包 as it is, then its changes pushed; a submission
 * while its 红包 page is the one shown, one at a time; the viewer's own
 * record.
 */
export function usePageBridge(
  frame: RefObject<HTMLIFrameElement | null>,
  url: string,
  activityId: string | null,
) {
  const origin = new URL(url).origin;
  const user = useSessionUser();
  const onPage = useCurrentActivityId() === activityId;
  const { data: activity } = useQuery({
    queryKey: activityKeys.public(activityId ?? "", user?.id ?? null),
    queryFn: skipToken,
    select: (detail: PublicActivityDetail) => detail.activity,
  });
  const board = useJudgeBoard({ id: activityId ?? "", judge: activity?.judge });
  const pushed = useAtomValue(liveJudgedAtom);
  const judged = activity?.judge
    ? Math.max(
        activity.judge.judged,
        pushed?.id === activity.id ? pushed.count : 0,
      )
    : null;
  const hongbao = activity ? hongbaoOf(activity, judged) : null;
  const view = viewOf(board.view);
  const { submitForPage } = useOmniboxController();
  // What the listener reads when a message comes, as of the last render.
  const now = useRef({ hongbao, view, board, onPage, user, submitForPage });
  now.current = { hongbao, view, board, onPage, user, submitForPage };
  /** Said hello: what it has been sent, to push only what changed. */
  const link = useRef<{ view: string; hongbao: string; line: number } | null>(
    null,
  );
  const busy = useRef({ submit: false, mine: false });

  useEffect(() => {
    if (activityId === null) return;
    const listen = async (event: MessageEvent) => {
      const target = frame.current?.contentWindow;
      if (!target || event.source !== target || event.origin !== origin) return;
      const ask = askOf(event.data);
      if (!ask) return;
      const reply = (answer: { value: unknown } | { error: object }) =>
        target.postMessage({ hb: 1, re: ask.id, ...answer }, origin);
      const state = now.current;
      if (ask.type === "hello") {
        // Before the 红包 is read, it knocks again.
        if (!state.hongbao) return;
        link.current = {
          view: JSON.stringify(state.view),
          hongbao: JSON.stringify(state.hongbao),
          line: state.board.lines[0]?.n ?? -1,
        };
        reply({
          value: {
            hongbao: state.hongbao,
            viewer: state.user
              ? { signedIn: true, name: state.user.displayName }
              : { signedIn: false },
            theme: "light",
            view: state.view,
          },
        });
        return;
      }
      if (ask.type === "submit") {
        if (!state.onPage) return reply({ value: notJudged("away") });
        if (busy.current.submit) return reply({ value: notJudged("busy") });
        busy.current.submit = true;
        try {
          reply({
            value: await state.submitForPage(activityId, ask.input, origin),
          });
        } finally {
          busy.current.submit = false;
        }
        return;
      }
      if (!state.user) return reply({ value: null });
      if (busy.current.mine)
        return reply({
          error: { code: "busy", message: "上一次 hb.mine() 还没读完" },
        });
      busy.current.mine = true;
      try {
        reply({ value: await readMine(activityId, ask.next) });
      } catch (error) {
        reply({
          error: {
            code: "error",
            message: error instanceof Error ? error.message : "没有读到",
          },
        });
      } finally {
        busy.current.mine = false;
      }
    };
    window.addEventListener("message", listen);
    return () => window.removeEventListener("message", listen);
  }, [activityId, frame, origin]);

  // Pushes: the view, the 红包, new lines of 动态 (oldest first).
  const viewText = JSON.stringify(view);
  const hongbaoText = JSON.stringify(hongbao);
  const lines = board.lines;
  useEffect(() => {
    const sent = link.current;
    const target = frame.current?.contentWindow;
    if (!sent || !target) return;
    const push = (event: string, value: unknown) =>
      target.postMessage({ hb: 1, event, value }, origin);
    if (viewText !== sent.view) {
      sent.view = viewText;
      push("view", JSON.parse(viewText));
    }
    if (hongbaoText !== sent.hongbao && hongbaoText !== "null") {
      sent.hongbao = hongbaoText;
      push("hongbao", JSON.parse(hongbaoText));
    }
    const fresh = lines.filter((line) => line.n > sent.line).reverse();
    if (fresh.length > 0) {
      sent.line = fresh[fresh.length - 1]?.n ?? sent.line;
      push("announce", fresh.map(lineOf));
    }
  }, [viewText, hongbaoText, lines, frame, origin]);
}
