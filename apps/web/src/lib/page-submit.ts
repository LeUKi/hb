import { atom, type useStore } from "jotai";

/**
 * 网页替你提交 (docs/judge-page-design.md §3.3, §11.8): the 附带网页 of a
 * 代码判定红包 submitting through the SDK, asked once per account, 红包
 * and site in PageSubmitDialog. 不允许 is not kept: the next one asks again.
 */
export type PageSubmitRequest = {
  /** The page's host name, as the dialog names it. */
  site: string;
  resolve: (allow: boolean) => void;
};

export const pageSubmitAtom = atom<PageSubmitRequest | null>(null);

type Store = ReturnType<typeof useStore>;

/** Allowed in this browser, newest last. Only this browser's. */
const ALLOWED = "hb.page-submit";
const ALLOWED_MAX = 200;
/** Where storage is not kept (a private window): this load's. */
const allowedNow = new Set<string>();

function allowedList(): string[] {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(ALLOWED) ?? "[]");
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
        [...allowedList().filter((saved) => saved !== key), key].slice(
          -ALLOWED_MAX,
        ),
      ),
    );
  } catch {
    // Kept for this load only.
  }
}

/** True once allowed, or when the dialog says 允许; false when it says no. */
export async function askPageSubmit(
  store: Store,
  {
    userId,
    activityId,
    origin,
  }: {
    userId: string;
    activityId: string;
    origin: string;
  },
) {
  const key = `${userId} ${activityId} ${origin}`;
  if (allowedNow.has(key) || allowedList().includes(key)) return true;
  store.get(pageSubmitAtom)?.resolve(false);
  const allow = await new Promise<boolean>((resolve) => {
    let settled = false;
    store.set(pageSubmitAtom, {
      site: new URL(origin).hostname,
      resolve: (answer) => {
        if (settled) return;
        settled = true;
        store.set(pageSubmitAtom, null);
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
export type PageSubmitResult =
  | {
      judged: true;
      claimed: true;
      amount: string;
      unit: "LDC" | "🐟";
      reply?: string;
    }
  | { judged: true; claimed: false; reply?: string }
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
