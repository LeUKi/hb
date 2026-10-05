import { normalizeAvatarUrl, type PublicUserProfile } from "@hb/contracts";
import { Link } from "@tanstack/react-router";
import { ExternalLink, User } from "lucide-react";
import {
  type FocusEvent,
  forwardRef,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { cn } from "../lib/utils";

type UserIdentityProps = {
  profile: PublicUserProfile;
  className?: string;
  selfActions?: boolean;
};

type PopupPosition = {
  top: number;
  left: number;
};

const popupWidth = 300;
const tabbableSelector =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function isVisible(element: HTMLElement) {
  const rect = element.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

export function UserIdentity({
  profile,
  className,
  selfActions = false,
}: UserIdentityProps) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<PopupPosition | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popupRef = useRef<HTMLDivElement>(null);
  const closeTimer = useRef<number | null>(null);
  const skipNextFocusOpen = useRef(false);
  const clickOpenRef = useRef(false);
  const lastTriggerPointerType = useRef<string | null>(null);
  const triggerWasOpenOnPointerDown = useRef(false);
  const popupId = useId();
  const label = profile.displayName || profile.username;

  const clearCloseTimer = useCallback(() => {
    if (closeTimer.current !== null) {
      window.clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
  }, []);

  const closePopup = useCallback(() => {
    clickOpenRef.current = false;
    setPosition(null);
    setOpen(false);
  }, []);

  const scheduleClose = useCallback(() => {
    clearCloseTimer();
    closeTimer.current = window.setTimeout(closePopup, 120);
  }, [clearCloseTimer, closePopup]);

  const updatePosition = useCallback(() => {
    const rect = triggerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const width = Math.min(popupWidth, window.innerWidth - 24);
    const left = Math.min(
      Math.max(12, rect.left),
      Math.max(12, window.innerWidth - width - 12),
    );
    const preferredTop = rect.bottom + 8;
    const popupHeight = popupRef.current?.getBoundingClientRect().height ?? 190;
    const candidateTop =
      preferredTop + popupHeight > window.innerHeight
        ? rect.top - popupHeight - 8
        : preferredTop;
    const maxTop = Math.max(12, window.innerHeight - popupHeight - 12);
    const top = Math.min(Math.max(12, candidateTop), maxTop);
    setPosition({ top, left });
  }, []);

  const focusNextAfterTrigger = useCallback(() => {
    const trigger = triggerRef.current;
    if (!trigger) return;
    const elements = Array.from(
      document.querySelectorAll<HTMLElement>(tabbableSelector),
    ).filter(
      (element) => isVisible(element) && !popupRef.current?.contains(element),
    );
    const index = elements.indexOf(trigger);
    elements[index + 1]?.focus();
  }, []);

  useLayoutEffect(() => {
    if (!open || !popupRef.current) return;
    updatePosition();
    const observer = new ResizeObserver(updatePosition);
    observer.observe(popupRef.current);
    return () => observer.disconnect();
  }, [open, updatePosition]);

  useEffect(() => {
    if (!open) return;
    updatePosition();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        closePopup();
        const focusIsAlreadyOnTrigger =
          document.activeElement instanceof Node &&
          triggerRef.current?.contains(document.activeElement);
        skipNextFocusOpen.current = !focusIsAlreadyOnTrigger;
        triggerRef.current?.focus({ preventScroll: true });
      }
    };
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (
        triggerRef.current?.contains(target) ||
        popupRef.current?.contains(target)
      )
        return;
      setOpen(false);
      clickOpenRef.current = false;
    };
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("pointerdown", onPointerDown);
    return () => {
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("pointerdown", onPointerDown);
    };
  }, [open, updatePosition, closePopup]);

  useEffect(() => () => clearCloseTimer(), [clearCloseTimer]);

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={cn(
          "inline-flex max-w-64 min-w-0 items-center gap-2 rounded-md px-1 py-0.5 text-left align-middle text-sm font-medium text-neutral-800 hover:bg-neutral-100 focus-visible:outline-2 focus-visible:outline-neutral-600",
          className,
        )}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? popupId : undefined}
        onPointerEnter={(event) => {
          if (event.pointerType !== "mouse") return;
          clearCloseTimer();
          clickOpenRef.current = false;
          setOpen(true);
        }}
        onPointerDown={(event) => {
          lastTriggerPointerType.current = event.pointerType;
          triggerWasOpenOnPointerDown.current = open;
        }}
        onPointerLeave={(event) => {
          if (event.pointerType === "mouse") scheduleClose();
        }}
        onFocus={() => {
          if (skipNextFocusOpen.current) {
            skipNextFocusOpen.current = false;
            return;
          }
          clearCloseTimer();
          clickOpenRef.current = false;
          setOpen(true);
        }}
        onBlur={(event) => {
          if (!event.relatedTarget) return;
          if (!popupRef.current?.contains(event.relatedTarget as Node | null))
            scheduleClose();
        }}
        onClick={() => {
          clearCloseTimer();
          if (
            open &&
            (clickOpenRef.current ||
              (lastTriggerPointerType.current !== "mouse" &&
                triggerWasOpenOnPointerDown.current))
          ) {
            closePopup();
            return;
          }
          clickOpenRef.current = true;
          setOpen(true);
        }}
        onKeyDown={(event) => {
          if (event.key === "Tab" && !event.shiftKey && open) {
            const firstLink =
              popupRef.current?.querySelector<HTMLElement>("a[href]");
            if (firstLink) {
              event.preventDefault();
              firstLink.focus();
            }
          }
        }}
      >
        <UserAvatar profile={profile} size="sm" />
        <span className="min-w-0 truncate">{label}</span>
      </button>
      {open
        ? createPortal(
            <UserCardPopup
              id={popupId}
              ref={popupRef}
              profile={profile}
              top={position?.top ?? 0}
              left={position?.left ?? 0}
              positioned={Boolean(position)}
              selfActions={selfActions}
              onPointerEnter={clearCloseTimer}
              onPointerLeave={(event) => {
                if (event.pointerType === "mouse") scheduleClose();
              }}
              onFocus={clearCloseTimer}
              onBlur={(event) => {
                if (!event.relatedTarget) return;
                if (
                  !triggerRef.current?.contains(
                    event.relatedTarget as Node | null,
                  )
                )
                  scheduleClose();
              }}
              onKeyDown={(event) => {
                if (event.key !== "Tab") return;
                const links = Array.from(
                  popupRef.current?.querySelectorAll<HTMLElement>("a[href]") ??
                    [],
                );
                const firstLink = links.at(0);
                const lastLink = links.at(-1);
                if (event.shiftKey && document.activeElement === firstLink) {
                  event.preventDefault();
                  triggerRef.current?.focus();
                  return;
                }
                if (!event.shiftKey && document.activeElement === lastLink) {
                  event.preventDefault();
                  closePopup();
                  focusNextAfterTrigger();
                }
              }}
            />,
            document.body,
          )
        : null}
    </>
  );
}

export function UserAvatar({
  profile,
  size = "sm",
}: {
  profile: Pick<PublicUserProfile, "displayName" | "username" | "avatarUrl">;
  size?: "sm" | "lg";
}) {
  const [failedAvatarUrl, setFailedAvatarUrl] = useState<string | null>(null);
  const label = profile.displayName || profile.username;
  const classes = size === "lg" ? "size-16 text-xl" : "size-7 text-xs";
  const avatarUrl = normalizeAvatarUrl(profile.avatarUrl);
  if (avatarUrl && failedAvatarUrl !== avatarUrl)
    return (
      <img
        src={avatarUrl}
        alt=""
        referrerPolicy="no-referrer"
        className={cn(
          classes,
          "shrink-0 rounded-full bg-neutral-100 object-cover",
        )}
        onError={() => setFailedAvatarUrl(avatarUrl)}
      />
    );
  return (
    <span
      className={cn(
        classes,
        "inline-flex shrink-0 items-center justify-center rounded-full bg-neutral-200 font-semibold text-neutral-600",
      )}
      aria-hidden="true"
      title={label}
    >
      {label ? label.slice(0, 1).toUpperCase() : <User className="size-4" />}
    </span>
  );
}

const UserCardPopup = forwardRef<
  HTMLDivElement,
  {
    id: string;
    profile: PublicUserProfile;
    top: number;
    left: number;
    positioned: boolean;
    selfActions: boolean;
    onPointerEnter: () => void;
    onPointerLeave: (event: ReactPointerEvent<HTMLDivElement>) => void;
    onFocus: () => void;
    onBlur: (event: FocusEvent<HTMLDivElement>) => void;
    onKeyDown: (event: ReactKeyboardEvent<HTMLDivElement>) => void;
  }
>(function UserCardPopup(
  {
    id,
    profile,
    top,
    left,
    positioned,
    selfActions,
    onPointerEnter,
    onPointerLeave,
    onFocus,
    onBlur,
    onKeyDown,
  },
  ref,
) {
  const label = profile.displayName || profile.username;
  const linuxDoProfile = `https://linux.do/u/${encodeURIComponent(
    profile.username,
  )}`;
  return (
    <div
      id={id}
      ref={ref}
      role="dialog"
      className="fixed z-50 max-h-[calc(100vh-24px)] w-[min(300px,calc(100vw-24px))] overflow-y-auto rounded-md border border-neutral-200 bg-white p-4 text-sm shadow-lg"
      style={{ top, left, visibility: positioned ? "visible" : "hidden" }}
      onPointerEnter={onPointerEnter}
      onPointerLeave={onPointerLeave}
      onFocus={onFocus}
      onBlur={onBlur}
      onKeyDown={onKeyDown}
    >
      <div className="flex min-w-0 gap-3">
        <UserAvatar profile={profile} size="lg" />
        <div className="min-w-0 space-y-1">
          <p className="break-words font-semibold text-neutral-950">{label}</p>
          <p className="break-all text-neutral-600">@{profile.username}</p>
        </div>
      </div>
      <div className="mt-4 flex flex-wrap gap-3">
        <PopupLink href={linuxDoProfile}>
          <ExternalLink className="size-4" />
          查看 Linux DO 主页
        </PopupLink>
        {selfActions ? (
          <Link
            to="/account"
            className="inline-flex items-center gap-2 text-sm underline underline-offset-4"
          >
            账号信息
          </Link>
        ) : null}
      </div>
    </div>
  );
});

function PopupLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-center gap-2 text-sm underline underline-offset-4"
    >
      {children}
    </a>
  );
}
