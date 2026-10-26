import { atom, type useStore } from "jotai";

/**
 * 自领 (docs/self-claim-design.md): the sender about to take a share of
 * their own 红包 (or sign up for their own draw), asked once in
 * SelfClaimDialog.
 */
export type SelfClaimRequest = {
  /** 限时开奖: 报名, a place rather than a share. */
  draw: boolean;
  /** Yes to go on, no to send nothing. */
  resolve: (go: boolean) => void;
};

export const selfClaimAtom = atom<SelfClaimRequest | null>(null);

type Store = ReturnType<typeof useStore>;

/** Opens the dialog and waits: true to go on, false once it is closed. */
export function askSelfClaim(store: Store, draw: boolean) {
  store.get(selfClaimAtom)?.resolve(false);
  return new Promise<boolean>((resolve) => {
    let settled = false;
    store.set(selfClaimAtom, {
      draw,
      resolve: (go) => {
        if (settled) return;
        settled = true;
        store.set(selfClaimAtom, null);
        resolve(go);
      },
    });
  });
}
