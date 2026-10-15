import { useAtom, useAtomValue, useSetAtom } from "jotai";
import { useRef, useState } from "react";
import {
  authErrorAtom,
  identityCheckingAtom,
  identityFailedAtom,
  identityRetriedAtom,
  submitSimAtom,
} from "../../lib/store";

/** 重试 after a failed identity check (the prototype's retry gets through). */
export function useIdentityRetry() {
  const [checking, setChecking] = useAtom(identityCheckingAtom);
  const setRetried = useSetAtom(identityRetriedAtom);
  const failed = useAtomValue(identityFailedAtom);
  const retry = () => {
    if (checking) return;
    // The button pressed is replaced once it works (by the avatar in the
    // 顶栏, by the menu in the 用户卡片): focus moves to what replaced it.
    const from = document.activeElement;
    const card = from?.closest<HTMLElement>('[role="dialog"]');
    const inPage = Boolean(from?.closest("#view"));
    setChecking(true);
    window.setTimeout(() => {
      setRetried(true);
      setChecking(false);
      // Two frames: the update may only be committed after the first.
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          if (document.activeElement !== document.body) return;
          if (card?.isConnected) card.focus({ preventScroll: true });
          else if (inPage)
            // The page that asked to check again, now itself: its title,
            // or the page while its data is still on the way.
            (
              [
                ...document.querySelectorAll<HTMLElement>("#view h1[tabindex]"),
              ].find(
                (title) =>
                  title.closest<HTMLElement>(".view-scroll")?.style
                    .pointerEvents === "auto",
              ) ?? document.getElementById("view")
            )?.focus({ preventScroll: true });
          else document.getElementById("identity-button")?.focus();
        }),
      );
    }, 700);
  };
  return { failed, checking, retry };
}

/**
 * 退出登录 is a request too, and can fail (production: "退出失败"); the
 * dev toolbar's 提交结果 fails the first try.
 */
export function useSignOut(onSignedOut: () => void) {
  const submitSim = useAtomValue(submitSimAtom);
  // A 刷新资料 that did not finish was this account's; it goes with it.
  const setAuthError = useSetAtom(authErrorAtom);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const failedOnce = useRef(false);
  const run = () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    window.setTimeout(() => {
      setBusy(false);
      if (submitSim !== "ok" && !failedOnce.current) {
        failedOnce.current = true;
        setError(
          "退出没有完成：网络或服务出了问题，你仍是登录状态。可以再试一次。",
        );
        return;
      }
      setAuthError(null);
      onSignedOut();
    }, 400);
  };
  return { busy, error, run };
}
