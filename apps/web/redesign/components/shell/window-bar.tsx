import { Link, useMatches } from "@tanstack/react-router";
import { useAtomValue } from "jotai";
import { CircleUserRound, Plus, RotateCw, ShieldAlert } from "lucide-react";
import { commandById } from "../../lib/commands";
import { sessionAtom, sessionReadyAtom, viewEdgeAtom } from "../../lib/store";
import { omniboxMetrics } from "../omnibox/state";
import { useOmniboxController } from "../omnibox/use-omnibox-controller";
import { Avatar } from "../ui/avatar";
import { useButtonShape } from "../ui/button";
import { MorphLabel } from "../ui/morph-label";
import { radius, SquircleFill } from "../ui/squircle";
import { BrandMark } from "./brand-mark";
import { CommandLink } from "./command-link";
import { useIdentityRetry } from "./identity-check";
import { useSlot } from "./slots";
import { WindowClip } from "./window-clip";
import { useWindowInfo } from "./window-info";

/** Window-bar controls are 40px tall. */
const BAR_BUTTON_RADIUS = 13;

function IdentityButton({ compact }: { compact: boolean }) {
  const shape = useButtonShape(BAR_BUTTON_RADIUS, 40);
  const user = useAtomValue(sessionAtom);
  const ready = useAtomValue(sessionReadyAtom);
  const { openAccount } = useOmniboxController();
  const identity = useIdentityRetry();
  if (!ready)
    return <span className="size-10 rounded-full bg-fill" aria-hidden="true" />;
  // The session request failed: the site works on as a guest; this retries
  // (production's "身份检查失败，重试").
  if (identity.failed)
    return (
      <button
        id="identity-button"
        type="button"
        onClick={identity.retry}
        aria-disabled={identity.checking || undefined}
        aria-label={identity.checking ? "正在确认身份" : "身份检查失败，重试"}
        title="身份检查失败，重试"
        className={`btn btn-ghost text-warning ${compact ? "size-10" : "h-10 gap-1.5 px-3 text-sm"}`}
        style={shape}
      >
        <SquircleFill radius={BAR_BUTTON_RADIUS} />
        <MorphLabel>
          {identity.checking ? (
            <RotateCw className="size-4 motion-safe:animate-spin" />
          ) : (
            <ShieldAlert className="size-[18px]" />
          )}
          {!compact &&
            (identity.checking ? "正在确认身份…" : "身份检查失败，重试")}
        </MorphLabel>
      </button>
    );
  if (!user)
    return (
      <button
        id="identity-button"
        type="button"
        onClick={openAccount}
        aria-label="登录"
        className={`btn btn-ghost ${compact ? "size-10" : "h-10 px-3.5 text-sm"}`}
        style={shape}
      >
        <SquircleFill radius={BAR_BUTTON_RADIUS} />
        {compact ? <CircleUserRound className="size-5" /> : "登录"}
      </button>
    );
  return (
    <button
      id="identity-button"
      type="button"
      onClick={openAccount}
      aria-label={`${user.displayName}，打开账号卡片`}
      title={user.displayName}
      className="grid size-10 place-items-center rounded-full transition-transform active:translate-y-px"
    >
      <Avatar name={user.displayName} size={compact ? 34 : 36} />
    </button>
  );
}

/**
 * The 顶栏, laid over the 内容区: home icon, the dock slot, create and account.
 * Clear while nothing is beneath it; frosted once a page bleeds under it or
 * content scrolls under it, with a hairline for the latter.
 */
export function WindowBar() {
  const homeShape = useButtonShape(radius.row, 44);
  const shape = useButtonShape(BAR_BUTTON_RADIUS, 40);
  const edge = useAtomValue(viewEdgeAtom);
  const { compact } = useWindowInfo();
  const dockSlot = useSlot("dock");
  const { goHome } = useOmniboxController();
  const metrics = omniboxMetrics(compact);
  const onNew = useMatches({
    select: (matches) => matches.at(-1)?.routeId === "/new",
  });

  return (
    <WindowClip top>
      <header
        data-bleed={edge.bleed || undefined}
        data-scrolled={edge.scrolled || undefined}
        className={`window-bar absolute inset-x-0 top-0 z-10 grid h-(--bar-h) items-center gap-2 px-3 @wide/window:gap-4 @wide/window:px-5 ${
          compact
            ? "grid-cols-[auto_minmax(0,1fr)_auto]"
            : "grid-cols-[minmax(10rem,1fr)_minmax(0,34rem)_minmax(10rem,1fr)]"
        }`}
      >
        <div className="flex min-w-0 items-center">
          {/* A ghost button so the brand glow is not clipped by a hover shape. */}
          <Link
            to="/"
            aria-label="起始页"
            title="起始页"
            onClick={(event) => {
              if (
                event.metaKey ||
                event.ctrlKey ||
                event.shiftKey ||
                event.altKey ||
                event.button !== 0
              )
                return;
              event.preventDefault();
              goHome();
            }}
            className="btn btn-ghost size-11"
            style={homeShape}
          >
            <SquircleFill radius={radius.row} />
            <BrandMark size={compact ? 32 : 34} />
          </Link>
        </div>
        <div className="flex min-w-0 justify-center">
          <div
            ref={dockSlot}
            aria-hidden="true"
            className="w-full"
            style={{ height: metrics.docked }}
          />
        </div>
        <div className="flex min-w-0 items-center justify-end gap-2">
          <CommandLink
            command={commandById("new")}
            aria-current={onNew ? "page" : undefined}
            aria-label="发红包"
            title="发红包 · /new"
            className={`btn btn-secondary ${compact ? "size-10" : "h-10 px-3.5 text-sm"}`}
            style={shape}
          >
            <SquircleFill radius={BAR_BUTTON_RADIUS} />
            <Plus className="size-[18px]" aria-hidden="true" />
            {!compact && "发红包"}
          </CommandLink>
          <IdentityButton compact={compact} />
        </div>
      </header>
    </WindowClip>
  );
}
