import { Link, useMatches } from "@tanstack/react-router";
import { useAtomValue } from "jotai";
import {
  CircleUserRound,
  History,
  Plus,
  RotateCw,
  ShieldAlert,
  Wrench,
} from "lucide-react";
import { cn } from "../../lib/cn";
import { commandById } from "../../lib/commands";
import { useIdentity } from "../../lib/session";
import { viewEdgeAtom } from "../../lib/store";
import { omniboxMetrics } from "../omnibox/state";
import { useOmniboxController } from "../omnibox/use-omnibox-controller";
import { Avatar } from "../ui/avatar";
import {
  buttonHeight,
  buttonRadius,
  buttonVariants,
  useButtonShape,
} from "../ui/button";
import { MorphLabel } from "../ui/morph-label";
import { SquircleFill } from "../ui/squircle";
import { BrandMark } from "./brand-mark";
import { CommandLink } from "./command-link";
import { useIdentityRetry } from "./identity-check";
import { useSlot } from "./slots";
import { WindowClip } from "./window-clip";
import { useWindowInfo } from "./window-info";

function IdentityButton({ compact }: { compact: boolean }) {
  const size = compact ? "icon-bar" : "bar";
  const shape = useButtonShape(buttonRadius[size], buttonHeight[size]);
  const { ready, user } = useIdentity();
  const { openAccount } = useOmniboxController();
  const identity = useIdentityRetry();
  if (!ready)
    return <span className="size-10 rounded-full bg-fill" aria-hidden="true" />;
  // The session request failed: the site works on as a guest; this retries
  // (production's "身份检查失败，重试"). In 维护模式 it says so instead.
  if (identity.failed) {
    const failure = identity.maintenance ? "系统维护中" : "身份检查失败，重试";
    return (
      <button
        id="identity-button"
        type="button"
        onClick={identity.retry}
        aria-disabled={identity.checking || undefined}
        aria-label={
          identity.checking
            ? "正在确认身份"
            : identity.maintenance
              ? "系统维护中，重新检查"
              : failure
        }
        title={identity.maintenance ? "系统维护中，请稍后再试" : failure}
        className={cn(
          buttonVariants({ variant: "ghost", size }),
          "text-warning",
          !compact && "gap-1.5 px-3",
        )}
        style={shape}
      >
        <SquircleFill radius={buttonRadius[size]} />
        <MorphLabel>
          {identity.checking ? (
            <RotateCw className="size-4 motion-safe:animate-spin" />
          ) : identity.maintenance ? (
            <Wrench className="size-[18px]" />
          ) : (
            <ShieldAlert className="size-[18px]" />
          )}
          {!compact && (identity.checking ? "正在确认身份…" : failure)}
        </MorphLabel>
      </button>
    );
  }
  if (!user)
    return (
      <button
        id="identity-button"
        type="button"
        onClick={openAccount}
        aria-label="登录"
        className={buttonVariants({ variant: "ghost", size })}
        style={shape}
      >
        <SquircleFill radius={buttonRadius[size]} />
        {compact ? <CircleUserRound className="size-5" /> : "登录"}
      </button>
    );
  return (
    <button
      id="identity-button"
      type="button"
      onClick={openAccount}
      aria-label={`${user.displayName}，打开用户卡片`}
      title={user.displayName}
      className="grid size-10 place-items-center rounded-full transition-transform active:translate-y-px"
    >
      <Avatar
        name={user.displayName}
        src={user.avatarUrl}
        size={compact ? 34 : 36}
      />
    </button>
  );
}

/**
 * The 顶栏, laid over the 内容区: home icon, the dock slot, create, records
 * and account.
 * Clear while nothing is beneath it; frosted once a page bleeds under it or
 * content scrolls under it, with a hairline for the latter.
 */
export function WindowBar() {
  const homeShape = useButtonShape(buttonRadius.icon, buttonHeight.icon);
  const { compact } = useWindowInfo();
  // 40px tall either way: with words or without, the same squircle.
  const barShape = useButtonShape(
    buttonRadius["icon-bar"],
    buttonHeight["icon-bar"],
  );
  const edge = useAtomValue(viewEdgeAtom);
  const dockSlot = useSlot("dock");
  const { goHome } = useOmniboxController();
  const metrics = omniboxMetrics(compact);
  const page = useMatches({ select: (matches) => matches.at(-1)?.routeId });

  return (
    <WindowClip top>
      <header
        data-bleed={edge.bleed || undefined}
        data-scrolled={edge.scrolled || undefined}
        className={`window-bar absolute inset-x-0 top-0 z-10 grid h-(--bar-h) items-center gap-2 pt-(--safe-top) pr-[calc(0.75rem+var(--safe-right))] pl-[calc(0.75rem+var(--safe-left))] @wide/window:gap-4 @wide/window:pr-[calc(1.25rem+var(--safe-right))] @wide/window:pl-[calc(1.25rem+var(--safe-left))] ${
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
            className={buttonVariants({ variant: "ghost", size: "icon" })}
            style={homeShape}
          >
            <SquircleFill radius={buttonRadius.icon} />
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
          {/* 发红包 has its words only where all three fit beside the
              address bar (66rem); 红包记录 is only ever its icon. */}
          <CommandLink
            command={commandById("new")}
            aria-current={page === "/new" ? "page" : undefined}
            aria-label="发红包"
            title="发红包 · /new"
            className={cn(
              buttonVariants({ variant: "secondary", size: "icon-bar" }),
              "text-sm @min-[66rem]/window:w-auto @min-[66rem]/window:px-3.5 @min-[66rem]/window:[&_svg]:size-[18px]",
            )}
            style={barShape}
          >
            <SquircleFill radius={buttonRadius["icon-bar"]} />
            <Plus aria-hidden="true" />
            <span className="hidden @min-[66rem]/window:inline">发红包</span>
          </CommandLink>
          <CommandLink
            command={commandById("history")}
            aria-current={page === "/history" ? "page" : undefined}
            aria-label="红包记录"
            title="红包记录 · /history"
            className={cn(
              buttonVariants({ variant: "secondary", size: "icon-bar" }),
              "@min-[66rem]/window:[&_svg]:size-[18px]",
            )}
            style={barShape}
          >
            <SquircleFill radius={buttonRadius["icon-bar"]} />
            <History aria-hidden="true" />
          </CommandLink>
          <IdentityButton compact={compact} />
        </div>
      </header>
    </WindowClip>
  );
}
