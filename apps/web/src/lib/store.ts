import { atom } from "jotai";

/**
 * What lies under the 顶栏 right now: a page drawn from the window's top edge
 * (bleed; lacquer for a 代码判定红包's black cover), or content scrolled
 * beneath it. The current view writes it.
 */
export const viewEdgeAtom = atom({
  bleed: false,
  lacquer: false,
  scrolled: false,
});

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
 * How many 红包 each /🔑/ result lists, once its page has read it: the
 * address bar says "匹配到 N 个红包".
 */
export const resultCountsAtom = atom<Record<string, number>>({});

/** The last 验证其他口令 that worked, for the 口令区 to highlight and say. */
export const verifyNoticeAtom = atom<{
  activityId: string;
  password: string;
  token: number;
} | null>(null);

/**
 * The draft just saved from /new, by id: its 红包 page, where saving lands
 * (07 §5), says 草稿已保存 once instead of 草稿预览.
 */
export const savedDraftAtom = atom<string | null>(null);
