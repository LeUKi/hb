import { atom } from "jotai";
import { atomWithStorage } from "jotai/utils";
import { seededClaims } from "../fixtures/activities";
import type { DrawSim, PaymentSim } from "../fixtures/hongbao";
import type { MerchantSim } from "../fixtures/merchants";
import type { RecentEntry } from "../fixtures/redemption";
import { seedRecent } from "../fixtures/redemption";
import {
  type IdentityKind,
  isIdentityKind,
  sessionFor,
} from "../fixtures/session";

const stored = { getOnInit: true } as const;

// 青春版 is gone. A browser that last chose it keeps "lite" in storage; read
// it as a guest, as production signs LiteAuth sessions out.
try {
  const key = "hb-redesign:identity";
  const saved = localStorage.getItem(key);
  if (saved !== null && !isIdentityKind(JSON.parse(saved)))
    localStorage.setItem(key, JSON.stringify("guest"));
} catch {
  // Storage unavailable or unreadable: the atom falls back to its default.
}

// Prototype controls (dev toolbar). Persisted so a reload keeps the setup.
export const identityKindAtom = atomWithStorage<IdentityKind>(
  "hb-redesign:identity",
  "standard",
  undefined,
  stored,
);
export const framePreviewAtom = atomWithStorage<"auto" | "phone" | "tablet">(
  "hb-redesign:frame",
  "auto",
  undefined,
  stored,
);
export const motionPrefAtom = atomWithStorage<"system" | "reduce">(
  "hb-redesign:motion",
  "system",
  undefined,
  stored,
);
/**
 * Dev toolbar: draw squircles the browser's way (CSS corner-shape where it
 * exists) or force the fallback that Safari and Firefox get (a clip-path,
 * with the rings drawn along it), to see it in Chrome.
 */
export const squircleModeAtom = atomWithStorage<"auto" | "fallback">(
  "hb-redesign:squircle-mode",
  "auto",
  undefined,
  stored,
);
/**
 * What lies under the 顶栏 right now: a page drawn from the window's top edge
 * (bleed), or content scrolled beneath it. The current view writes it.
 */
export const viewEdgeAtom = atom({ bleed: false, scrolled: false });
/** Dev toolbar: the timed draw's outcome. */
export const drawSimAtom = atomWithStorage<DrawSim>(
  "hb-redesign:draw",
  "waiting",
  undefined,
  stored,
);
/** Dev toolbar: payment status of the viewer's claims. */
export const paymentSimAtom = atomWithStorage<PaymentSim>(
  "hb-redesign:payment",
  "auto",
  undefined,
  stored,
);
/** Dev toolbar: the current LDC merchant's state (/merchant, /new). */
/** Bumped when a merchant's 密钥 check starts or ends (see merchant-view). */
export const merchantCheckTickAtom = atom(0);
export const merchantSimAtom = atomWithStorage<MerchantSim>(
  "hb-redesign:merchant",
  "passed",
  undefined,
  stored,
);
/**
 * Dev toolbar 提交结果: how the next submission ends — a claim or sign-up,
 * a save on 发红包 / 📝, 商户配置 or 网站设置. 正常 succeeds; 失败 is a
 * definite error (nothing happened); 结果未知 lost the response (the
 * request may have gone through: retry the same submission); 太频繁 is a
 * 429; 版本冲突 a 409 (someone changed it meanwhile). Each flow plays the
 * ones production can return there and treats the rest as 失败.
 */
export type SubmitSim = "ok" | "failed" | "unknown" | "throttled" | "conflict";
export const submitSimAtom = atomWithStorage<SubmitSim>(
  "hb-redesign:submit",
  "ok",
  undefined,
  stored,
);

/**
 * Dev toolbar: how the step-3 pages' data arrives — at once, after a
 * skeleton, not at all (读取失败), with a failed background refresh, or with
 * one failed batch while a list loads more (加载更多失败).
 */
export type PageLoadSim = "normal" | "slow" | "error" | "stale" | "more-error";
export const pageLoadSimAtom = atomWithStorage<PageLoadSim>(
  "hb-redesign:page-load",
  "normal",
  undefined,
  stored,
);
export const slowBootAtom = atomWithStorage<boolean>(
  "hb-redesign:slow-boot",
  false,
  undefined,
  stored,
);
/**
 * Dev toolbar: a simulated phone keyboard over the window's bottom while a
 * text field has focus in a phone-sized window, to try the 指令框's search
 * mode on a desktop.
 */
export const simKeyboardAtom = atomWithStorage<boolean>(
  "hb-redesign:sim-keyboard",
  false,
  undefined,
  stored,
);

/**
 * How many page dialogs (WindowDialog: confirmations, leave guard, compact
 * detail) are open. While any is, the rest of the window is inert and the
 * 指令框 shortcuts do nothing, as with the history-backed panels.
 */
export const windowDialogsAtom = atom(0);

/**
 * The tab's title from the page itself, when the route alone can't tell
 * (未找到页面, 帖子里的红包…): set by the page on screen, cleared as it
 * leaves. See usePageTitle.
 */
export const pageTitleAtom = atom<{ title: string } | null>(null);

/**
 * Why the last sign-in did not finish (from ?authError=…), until retried,
 * and whose it was: an account's 刷新资料 (shown on its /me) or a guest's
 * sign-in (shown in the login card). Another account never sees it.
 */
export const authErrorAtom = atom<{
  code: string;
  owner: string | null;
} | null>(null);

/**
 * Dev toolbar 身份检查: the session request fails. Production keeps the
 * site working as a guest and offers 重试 (header) or 重新检查 (pages
 * that need an account). A retry that went through holds for this visit.
 */
export const identityCheckSimAtom = atomWithStorage<"ok" | "failed">(
  "hb-redesign:identity-check",
  "ok",
  undefined,
  stored,
);
export const identityRetriedAtom = atom(false);
export const identityCheckingAtom = atom(false);
export const identityFailedAtom = atom(
  (get) => get(identityCheckSimAtom) === "failed" && !get(identityRetriedAtom),
);

export const sessionAtom = atom((get) =>
  get(identityFailedAtom) ? null : sessionFor(get(identityKindAtom)),
);
export const sessionReadyAtom = atom(false);

// Local attempt history: in memory per account (production keeps IndexedDB).
// The 新账号 starts empty; the others with a few sample entries.
const recentByUserAtom = atom<Record<string, RecentEntry[]>>({});
const noRecent: RecentEntry[] = [];
export const recentAtom = atom(
  (get) => {
    const user = get(sessionAtom);
    if (!user) return [];
    return (
      get(recentByUserAtom)[user.id] ??
      (user.fresh ? noRecent : seedRecent(Date.now()))
    );
  },
  (get, set, entry: RecentEntry) => {
    const user = get(sessionAtom);
    if (!user) return;
    const current = get(recentAtom).filter(
      (item) => item.password !== entry.password,
    );
    set(recentByUserAtom, {
      ...get(recentByUserAtom),
      [user.id]: [entry, ...current].slice(0, 100),
    });
  },
);

/** Removes one 口令 from this account's 最近输入. */
export const removeRecentAtom = atom(null, (get, set, password: string) => {
  const user = get(sessionAtom);
  if (!user) return;
  set(recentByUserAtom, {
    ...get(recentByUserAtom),
    [user.id]: get(recentAtom).filter((item) => item.password !== password),
  });
});

/** 清空最近输入 (this account, this browser). */
export const clearRecentAtom = atom(null, (get, set) => {
  const user = get(sessionAtom);
  if (!user) return;
  set(recentByUserAtom, { ...get(recentByUserAtom), [user.id]: [] });
});

export type ClaimRecord = {
  kind: "claimed" | "registered";
  amount?: string;
  password: string | null;
  at: number;
};

// Every signed-in demo account starts with its earlier claims on the
// ended 红包 (中秋红包, 上周抽奖); resetting returns to that.
const claimsByUserAtom = atom<Record<string, Record<string, ClaimRecord>>>({});
const seeded: Record<string, ClaimRecord> = seededClaims();
const noClaims: Record<string, ClaimRecord> = {};
const startingClaims = (user: { fresh?: boolean }) =>
  user.fresh ? noClaims : seeded;
export const claimsAtom = atom(
  (get) => {
    const user = get(sessionAtom);
    return user
      ? (get(claimsByUserAtom)[user.id] ?? startingClaims(user))
      : noClaims;
  },
  (get, set, activityId: string, record: ClaimRecord) => {
    const user = get(sessionAtom);
    if (!user) return;
    const all = get(claimsByUserAtom);
    set(claimsByUserAtom, {
      ...all,
      [user.id]: {
        ...(all[user.id] ?? startingClaims(user)),
        [activityId]: record,
      },
    });
  },
);

/**
 * 口令 each account has verified per 红包 (验证其他口令). Memory only, like
 * every 口令 in the prototype: never written to storage.
 */
const solvedByUserAtom = atom<Record<string, Record<string, string[]>>>({});
const noSolved: Record<string, string[]> = {};
export const solvedAtom = atom(
  (get) => {
    const user = get(sessionAtom);
    return user ? (get(solvedByUserAtom)[user.id] ?? noSolved) : noSolved;
  },
  (get, set, activityId: string, password: string) => {
    const user = get(sessionAtom);
    if (!user) return;
    const all = get(solvedByUserAtom);
    const mine = all[user.id] ?? {};
    const list = mine[activityId] ?? [];
    if (list.includes(password)) return;
    set(solvedByUserAtom, {
      ...all,
      [user.id]: { ...mine, [activityId]: [...list, password] },
    });
  },
);

/** The last verify result, for the 口令区 to highlight and announce. */
export const verifyNoticeAtom = atom<{
  activityId: string;
  password: string;
  token: number;
} | null>(null);

export const resetDataAtom = atom(null, (_get, set) => {
  set(recentByUserAtom, {});
  set(claimsByUserAtom, {});
  set(solvedByUserAtom, {});
  set(verifyNoticeAtom, null);
  set(cooldownUntilAtom, 0);
});

/** Shared per-account attempt cooldown (home 5s, activity page 2s). */
export const cooldownUntilAtom = atom(0);

/** One-shot auto-submit after a single discovery match. Memory only. */
export const intentAtom = atom<{
  activityId: string;
  password: string;
  token: number;
} | null>(null);

/** 口令 behind each multi-match result id. Memory only, never in the URL. */
export const resultPasswords = new Map<string, string>();
