import type { PageIdentity } from "@hb/contracts";
import { atom, type useStore } from "jotai";

/**
 * 网页的许可 (docs/page-identity-design.md §3): the 附带网页 knowing who the
 * viewer is (hb.identity()) and, on a 代码判定红包, submitting for them
 * (hb.submit(), docs/judge-page-design.md §3.3), asked together the first
 * time the page wants either, once per account, 红包 and site, in
 * PagePermissionDialog. 不允许 is not kept: the next one asks again.
 */
export type PagePermissionRequest = {
  /** The page's host name, as the dialog names it. */
  site: string;
  /** A 代码判定红包: submitting is asked too. */
  code: boolean;
  resolve: (allow: boolean) => void;
};

export const pagePermissionAtom = atom<PagePermissionRequest | null>(null);

type Store = ReturnType<typeof useStore>;

/** Allowed in this browser, newest last. Only this browser's. */
const ALLOWED = "hb.page-allow";
/**
 * 让这个网页替你提交？ as it was asked before 2026-11-01: submitting only,
 * never who they are.
 */
const SUBMIT_ONLY = "hb.page-submit";
const ALLOWED_MAX = 200;
/** Where storage is not kept (a private window): this load's. */
const allowedNow = new Set<string>();

function listOf(name: string): string[] {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(name) ?? "[]");
    return Array.isArray(saved)
      ? saved.filter((key): key is string => typeof key === "string")
      : [];
  } catch {
    return [];
  }
}

function remember(key: string) {
  allowedNow.add(key);
  try {
    localStorage.setItem(
      ALLOWED,
      JSON.stringify(
        [...listOf(ALLOWED).filter((saved) => saved !== key), key].slice(
          -ALLOWED_MAX,
        ),
      ),
    );
  } catch {
    // Kept for this load only.
  }
}

/**
 * True once allowed (submitting, also as allowed before 2026-11-01), or
 * when the dialog says 允许; false when it says no.
 */
export async function askPagePermission(
  store: Store,
  {
    userId,
    activityId,
    origin,
    code,
    want,
  }: {
    userId: string;
    activityId: string;
    origin: string;
    code: boolean;
    want: "identity" | "submit";
  },
) {
  const key = `${userId} ${activityId} ${origin}`;
  if (
    allowedNow.has(key) ||
    listOf(ALLOWED).includes(key) ||
    (want === "submit" && listOf(SUBMIT_ONLY).includes(key))
  )
    return true;
  store.get(pagePermissionAtom)?.resolve(false);
  const allow = await new Promise<boolean>((resolve) => {
    let settled = false;
    store.set(pagePermissionAtom, {
      site: new URL(origin).hostname,
      code,
      resolve: (answer) => {
        if (settled) return;
        settled = true;
        store.set(pagePermissionAtom, null);
        resolve(answer);
      },
    });
  });
  if (allow) remember(key);
  return allow;
}

/** Why `hb.submit()` was not judged (§11.8 没判定的原因). */
export type PageSubmitReason =
  | "denied"
  | "login"
  | "cooldown"
  | "busy"
  | "human_check"
  | "not_in_scope"
  | "already_claimed"
  | "not_open"
  | "ended"
  | "paused"
  | "judge_failed"
  | "try_later"
  | "invalid_input"
  | "unconfirmed"
  | "away"
  | "not_code"
  | "error";

/** What the page gets back: the outcome only, for it to word itself. */
/**
 * Protocol 5 (docs/multi-prize-design.md §4.4): what a judgment moved for
 * the one judged — signed, as "-0.20" — their 待结算 after, and whether it
 * settled them.
 */
export type PageMoved = { added: string; pending: string; settled: boolean };

export type PageSubmitResult =
  | ({
      judged: true;
      claimed: true;
      amount: string;
      unit: "LDC" | "🐟";
      reply?: string;
    } & Partial<PageMoved>)
  | ({ judged: true; claimed: false; reply?: string } & Partial<PageMoved>)
  | {
      judged: false;
      reason: PageSubmitReason;
      seconds?: number;
      message?: string;
    };

export const notJudged = (
  reason: PageSubmitReason,
  more: { seconds?: number; message?: string } = {},
): PageSubmitResult => ({ judged: false, reason, ...more });

/**
 * Why `hb.fill()` did not fill the box (§11.11): what the 红包 page can
 * tell by itself, without asking the server.
 */
export type PageFillReason =
  | "no_input"
  | "login"
  | "not_open"
  | "ended"
  | "paused"
  | "already_claimed"
  | "not_in_scope"
  | "busy"
  | "invalid_input"
  | "away";

export type PageFillResult =
  | { filled: true }
  | { filled: false; reason: PageFillReason; message?: string };

export const notFilled = (
  reason: PageFillReason,
  message?: string,
): PageFillResult => ({
  filled: false,
  reason,
  ...(message ? { message } : {}),
});

/** Why `hb.identity()` gave no token (docs/page-identity-design.md §4). */
export type PageIdentityReason =
  | "login"
  | "denied"
  | "away"
  | "busy"
  | "unavailable"
  | "error";

/** A token for the page's own server, or why there is none. */
export type PageIdentityResult =
  | ({ identified: true } & PageIdentity)
  | { identified: false; reason: PageIdentityReason; message?: string };

export const notIdentified = (
  reason: PageIdentityReason,
  message?: string,
): PageIdentityResult => ({
  identified: false,
  reason,
  ...(message ? { message } : {}),
});
