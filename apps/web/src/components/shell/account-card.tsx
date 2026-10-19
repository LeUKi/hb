import { useQueryClient } from "@tanstack/react-query";
import { useLocation, useRouter } from "@tanstack/react-router";
import { useAtom, useSetAtom } from "jotai";
import { AlertTriangle, Info, LogOut } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useRef } from "react";
import { getLoginHref } from "../../lib/auth";
import { authErrorOf } from "../../lib/auth-errors";
import {
  type CommandId,
  commandById,
  featuresOf,
  isVisible,
  roleOf,
} from "../../lib/commands";
import { useMaintenance } from "../../lib/maintenance";
import { ease, useReducedMotionPref } from "../../lib/motion";
import { closeOverlay, openOverlay } from "../../lib/overlay";
import { sessionUserOf, useIdentity } from "../../lib/session";
import { authErrorAtom } from "../../lib/store";
import { Callout } from "../page/page";
import { Avatar } from "../ui/avatar";
import { Button } from "../ui/button";
import { radius, Squircle, SquirclePlate } from "../ui/squircle";
import { CommandLink } from "./command-link";
import { useIdentityRetry, useSignOut } from "./identity-check";
import { useOverlayFocus } from "./use-overlay-focus";
import { WindowClip } from "./window-clip";
import { useWindowInfo } from "./window-info";

// 账号资料 (/me) is the card's head: the name itself.
const cardCommands: CommandId[] = [
  "history",
  "balance",
  "merchant",
  "payments",
  "admin",
];

/**
 * The identity check failed: maybe signed in, maybe not. Check again. In
 * 维护模式 nobody can sign in either; the site says so and comes back by
 * itself (lib/maintenance.ts).
 */
function IdentityFailedContent() {
  const { checking, retry } = useIdentityRetry();
  const maintenance = useMaintenance();
  return (
    <div className="grid gap-4 p-4">
      <h2 id="account-card-title" className="px-1 text-lg font-semibold">
        {maintenance ? "系统维护中" : "身份检查失败"}
      </h2>
      <p className="px-1 text-sm text-ink-2">
        {maintenance
          ? "暂时不能登录、领取和发红包。维护通常几分钟就结束，结束后页面会自己恢复。"
          : "没能确认你的登录状态，现在按游客浏览。请重新检查；还没登录的话，检查后再登录。"}
      </p>
      <Button
        variant="primary"
        size="lg"
        className="w-full"
        aria-disabled={checking || undefined}
        onClick={retry}
      >
        {checking ? "正在确认身份…" : "重新检查"}
      </Button>
    </div>
  );
}

/** Off to LINUX DO Connect; it comes back to the page this started on. */
function signIn() {
  const { pathname, search, hash } = window.location;
  window.location.assign(getLoginHref(`${pathname}${search}${hash}`));
}

function LoginContent() {
  const [authError, setAuthError] = useAtom(authErrorAtom);
  const { failed } = useIdentity();
  const maintenance = useMaintenance();
  const error =
    authError && authError.owner === null ? authErrorOf(authError.code) : null;
  if (failed || maintenance) return <IdentityFailedContent />;
  return (
    <div className="grid gap-4 p-4">
      <h2 id="account-card-title" className="px-1 text-lg font-semibold">
        登录
      </h2>
      {error && (
        <div role="alert">
          <Callout
            tone={error.tone}
            icon={error.tone === "neutral" ? Info : AlertTriangle}
          >
            {error.text}
          </Callout>
        </div>
      )}
      <Button
        variant="primary"
        size="lg"
        className="w-full"
        disabled={error?.unavailable}
        onClick={() => {
          setAuthError(null);
          signIn();
        }}
      >
        {error?.unavailable
          ? "登录暂时不可用"
          : error
            ? "再试一次"
            : "通过 LINUX DO 登录"}
      </Button>
    </div>
  );
}

/**
 * LINUX DO sent someone back without a session (?authError=…): drop the
 * parameter from the address (a reload must not repeat it) and open the
 * card on the login view, which says why.
 */
export function AuthErrorWatcher() {
  const code = useLocation({
    select: (location) => {
      const value = (location.search as Record<string, unknown>).authError;
      return typeof value === "string" ? value : null;
    },
  });
  const pathname = useLocation({ select: (location) => location.pathname });
  const router = useRouter();
  const setError = useSetAtom(authErrorAtom);
  const queryClient = useQueryClient();
  // Whose round trip it was is only known once the identity check is in.
  const { ready } = useIdentity();
  // Once per callback (StrictMode runs effects twice).
  const handled = useRef(false);
  useEffect(() => {
    if (!code) {
      handled.current = false;
      return;
    }
    if (handled.current || !ready) return;
    handled.current = true;
    const user = sessionUserOf(queryClient);
    setError({ code, owner: user?.id ?? null });
    // Someone signed in comes back from 刷新资料: the session stays, and
    // /me (where that round trip starts) says it did not finish.
    if (user) {
      router.history.replace("/me", {});
      return;
    }
    router.history.replace(pathname, {});
    // The router's history merges a replace and a push made in the same
    // tick into one push, which would keep ?authError in the entry the card
    // closes back to. Open the card once the replace has gone through.
    window.setTimeout(() => openOverlay(router, { panel: "account" }), 0);
  }, [code, pathname, queryClient, ready, router, setError]);
  return null;
}

function AccountContent({ onDone }: { onDone: () => void }) {
  const { user } = useIdentity();
  const signOut = useSignOut(onDone);
  if (!user) return <LoginContent />;
  const role = roleOf(user);
  const me = commandById("me");
  return (
    <div className="grid gap-1 p-2">
      <Squircle radius={radius.row}>
        <CommandLink
          command={me}
          className="flex items-center gap-3 px-2.5 py-2 transition-colors hover:bg-fill-2"
        >
          <Avatar name={user.displayName} src={user.avatarUrl} size={44} />
          <span className="grid min-w-0 flex-1">
            <span
              id="account-card-title"
              className="truncate text-base font-semibold text-ink"
            >
              {user.displayName}
            </span>
            <span className="truncate text-sm text-ink-2">
              @{user.username}
            </span>
          </span>
          <span className="sr-only">{me.title}</span>
          <span className="font-mono text-xs text-ink-3">{me.path}</span>
        </CommandLink>
      </Squircle>
      <ul className="grid">
        {cardCommands
          .map((id) => commandById(id))
          .filter((command) => isVisible(command, role, featuresOf(user)))
          .map((command) => {
            const Icon = command.icon;
            return (
              <li key={command.id}>
                <Squircle radius={radius.row}>
                  <CommandLink
                    command={command}
                    className="flex h-11 items-center gap-3 px-2.5 text-base text-ink transition-colors hover:bg-fill-2"
                  >
                    <Icon className="size-[18px] shrink-0 text-ink-2" />
                    <span className="flex-1 truncate">{command.title}</span>
                    <span className="font-mono text-xs text-ink-3">
                      {command.path}
                    </span>
                  </CommandLink>
                </Squircle>
              </li>
            );
          })}
      </ul>
      <div className="mx-1 grid gap-1 border-t border-line pt-1.5">
        {signOut.error && (
          <p role="alert" className="px-2 text-sm text-danger">
            {signOut.error}
          </p>
        )}
        <Button
          variant="danger"
          size="sm"
          className="w-full justify-start px-2"
          labelAlign="start"
          aria-disabled={signOut.busy || undefined}
          onClick={signOut.run}
        >
          <LogOut />
          {signOut.busy ? "正在退出…" : "退出登录"}
        </Button>
      </div>
    </div>
  );
}

/** On-demand account card anchored under the avatar, over a blurred view. */
export function AccountCard() {
  const open = useLocation({
    select: (location) => location.state.panel === "account",
  });
  const router = useRouter();
  const { compact } = useWindowInfo();
  const reduced = useReducedMotionPref();
  const { panelRef, onExitComplete } = useOverlayFocus(open, "identity-button");
  const close = () => closeOverlay(router);
  const fade = {
    initial: { opacity: 0 },
    animate: { opacity: 1 },
    exit: { opacity: 0, transition: { duration: reduced ? 0 : 0.12 } },
    transition: { duration: reduced ? 0 : 0.18, ease },
  };

  return (
    <AnimatePresence onExitComplete={onExitComplete}>
      {open && (
        <>
          <WindowClip key="scrim">
            <motion.div
              aria-hidden="true"
              className="scrim absolute inset-0 z-40"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: reduced ? 0 : 0.22, ease }}
              onClick={close}
            />
          </WindowClip>
          <motion.div
            key="card"
            ref={panelRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="account-card-title"
            tabIndex={-1}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                close();
              }
            }}
            // The safe area's sides as margins: an inset box keeps clear of it.
            className={`absolute z-50 mr-(--safe-right) ml-(--safe-left) flex flex-col outline-none ${
              compact ? "inset-x-2" : "right-3 w-[20rem] @wide/window:right-5"
            }`}
            style={{
              top: "calc(var(--bar-h) - 0.25rem)",
              maxHeight: "calc(100% - var(--bar-h) - 0.75rem)",
              transformOrigin: "top right",
            }}
            initial={{ scale: reduced ? 1 : 0.96, y: reduced ? 0 : -4 }}
            animate={{ scale: 1, y: 0 }}
            exit={{
              scale: reduced ? 1 : 0.97,
              transition: { duration: reduced ? 0 : 0.12 },
            }}
            transition={{ duration: reduced ? 0 : 0.18, ease }}
          >
            <SquirclePlate
              className="pop-plate"
              radius={radius.pop}
              {...fade}
            />
            <Squircle radius={radius.pop}>
              <motion.div
                className="glass-pop relative min-h-0 flex-1 overflow-y-auto"
                {...fade}
              >
                <AccountContent onDone={close} />
              </motion.div>
            </Squircle>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}
