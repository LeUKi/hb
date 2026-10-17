import { useSetAtom } from "jotai";
import { useLogout } from "../../lib/auth";
import { useMaintenance } from "../../lib/maintenance";
import { useIdentity } from "../../lib/session";
import { authErrorAtom } from "../../lib/store";

/** The page on screen: its title, or the page while its data is on the way. */
function focusPage() {
  (
    [...document.querySelectorAll<HTMLElement>("#view h1[tabindex]")].find(
      (title) =>
        title.closest<HTMLElement>(".view-scroll")?.style.pointerEvents ===
        "auto",
    ) ?? document.getElementById("view")
  )?.focus({ preventScroll: true });
}

/** 重试 after a failed identity check: the session request again. */
export function useIdentityRetry() {
  const identity = useIdentity();
  const retry = () => {
    if (identity.checking) return;
    // The button pressed is replaced once it works (by the avatar in the
    // 顶栏, by the menu in the 用户卡片): focus moves to what replaced it.
    const from = document.activeElement;
    const card = from?.closest<HTMLElement>('[role="dialog"]');
    const inPage = Boolean(from?.closest("#view"));
    void identity.retry().then((result) => {
      if (result.isError) return;
      // Two frames: the update may only be committed after the first.
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          if (document.activeElement !== document.body) return;
          if (card?.isConnected) card.focus({ preventScroll: true });
          else if (inPage) focusPage();
          else document.getElementById("identity-button")?.focus();
        }),
      );
    });
  };
  return {
    failed: identity.failed,
    maintenance: identity.maintenance,
    checking: identity.checking,
    retry,
  };
}

/** 退出登录: a request too, which can fail; the account then stays. */
export function useSignOut(onSignedOut: () => void) {
  const { csrfToken } = useIdentity();
  // A 刷新资料 that did not finish was this account's; it goes with it.
  const setAuthError = useSetAtom(authErrorAtom);
  const logout = useLogout(csrfToken);
  const maintenance = useMaintenance();
  const run = () => {
    if (logout.isPending) return;
    logout.mutate(undefined, {
      onSuccess: () => {
        setAuthError(null);
        onSignedOut();
      },
    });
  };
  return {
    busy: logout.isPending,
    error: logout.isError
      ? maintenance
        ? "退出没有完成：系统维护中，你仍是登录状态。请稍后再试。"
        : "退出没有完成：网络或服务出了问题，你仍是登录状态。可以再试一次。"
      : null,
    run,
  };
}
