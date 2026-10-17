import type { HumanCheckChallenge } from "@hb/contracts";
import { atom, type useStore } from "jotai";

/**
 * A claim or sign-up waiting on 领取前人机验证: its 红包 asked for a
 * Turnstile token (HUMAN_CHECK_REQUIRED), shown in HumanCheckDialog.
 */
export type HumanCheckRequest = {
  challenge: HumanCheckChallenge;
  /** The sender's username: the dialog says whose requirement it is. */
  author: string | null;
  /** The token sent last time did not pass. */
  again: boolean;
  /** Passed: the claim is on its way with the token, and the dialog waits. */
  passed: boolean;
  /** With a token once it passes, or null once the dialog is closed. */
  resolve: (token: string | null) => void;
};

export const humanCheckAtom = atom<HumanCheckRequest | null>(null);

type Store = ReturnType<typeof useStore>;

/**
 * Opens the dialog (or asks again in it) and waits: a token, or null if it
 * was closed instead. Passed, the dialog stays until endHumanCheck.
 */
export function askHumanCheck(
  store: Store,
  request: Pick<HumanCheckRequest, "challenge" | "author" | "again">,
) {
  store.get(humanCheckAtom)?.resolve(null);
  return new Promise<string | null>((resolve) => {
    let settled = false;
    const current: HumanCheckRequest = {
      ...request,
      passed: false,
      resolve: (token) => {
        if (settled) return;
        settled = true;
        store.set(humanCheckAtom, token ? { ...current, passed: true } : null);
        resolve(token);
      },
    };
    store.set(humanCheckAtom, current);
  });
}

/** The claim it was for is answered (or given up): the dialog closes. */
export function endHumanCheck(store: Store) {
  store.get(humanCheckAtom)?.resolve(null);
  store.set(humanCheckAtom, null);
}
