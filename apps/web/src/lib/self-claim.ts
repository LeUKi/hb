import { atom, type useStore } from "jotai";

/**
 * 自领 (docs/self-claim-design.md): the sender about to take a share of
 * their own 红包 (or sign up for their own draw), asked in SelfClaimDialog
 * the first time for each 红包.
 */
export type SelfClaimRequest = {
  /** 限时开奖: 报名, a place rather than a share. */
  draw: boolean;
  /** Yes to go on, no to send nothing. */
  resolve: (go: boolean) => void;
};

export const selfClaimAtom = atom<SelfClaimRequest | null>(null);

type Store = ReturnType<typeof useStore>;

/** The 红包 already said yes to in this browser, newest last. */
const AGREED = "hb.self-claim";
const AGREED_MAX = 200;
/** Where storage is not kept (a private window): this load's. */
const agreedNow = new Set<string>();

function agreedList(): string[] {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(AGREED) ?? "[]");
    return Array.isArray(saved)
      ? saved.filter((id): id is string => typeof id === "string")
      : [];
  } catch {
    return [];
  }
}

function agree(activityId: string) {
  agreedNow.add(activityId);
  try {
    localStorage.setItem(
      AGREED,
      JSON.stringify(
        [...agreedList().filter((id) => id !== activityId), activityId].slice(
          -AGREED_MAX,
        ),
      ),
    );
  } catch {
    // Kept for this load only.
  }
}

/**
 * Opens the dialog and waits: true to go on (at once for a 红包 said yes
 * to before), false once it is closed. 返回 is not kept.
 */
export async function askSelfClaim(
  store: Store,
  activityId: string,
  draw: boolean,
) {
  if (agreedNow.has(activityId) || agreedList().includes(activityId))
    return true;
  store.get(selfClaimAtom)?.resolve(false);
  const go = await new Promise<boolean>((resolve) => {
    let settled = false;
    store.set(selfClaimAtom, {
      draw,
      resolve: (answer) => {
        if (settled) return;
        settled = true;
        store.set(selfClaimAtom, null);
        resolve(answer);
      },
    });
  });
  if (go) agree(activityId);
  return go;
}
