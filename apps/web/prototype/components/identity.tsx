import { ArrowUpRight, X } from "lucide-react";
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { portalPosition, usePortalTarget } from "./portal-target";
import "./identity.css";

type ProfilePosition = {
  top: number;
  left: number;
  side: "right" | "left" | "sheet";
};

let activeProfile: { id: string; close: () => void } | null = null;
const screenInset = 12;
const profileGap = 8;

export function Avatar({
  name,
  color = "sage",
  large = false,
}: {
  name: string;
  color?: string;
  large?: boolean;
}) {
  return (
    <span
      className={`avatar avatar-${color} ${large ? "avatar-large" : ""}`}
      aria-hidden="true"
    >
      <span>{Array.from(name)[0]}</span>
    </span>
  );
}

export function UserIdentity({
  name,
  username,
  color = "sage",
}: {
  name: string;
  username: string;
  color?: string;
}) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<ProfilePosition | null>(null);
  const button = useRef<HTMLButtonElement>(null);
  const portalTarget = usePortalTarget(button);
  const popup = useRef<HTMLDivElement>(null);
  const openingScroll = useRef(
    new Map<EventTarget, { top: number; left: number }>(),
  );
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const returningFocus = useRef(false);
  const openedWithKeyboard = useRef(false);
  const openReason = useRef<"hover" | "focus" | "press">("hover");
  const id = useId();
  const cancelClose = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  }, []);
  const hide = useCallback(() => {
    cancelClose();
    setOpen(false);
    if (activeProfile?.id === id) activeProfile = null;
  }, [cancelClose, id]);
  function show(reason: "hover" | "focus" | "press") {
    cancelClose();
    if (reason === "hover") openedWithKeyboard.current = false;
    if (activeProfile?.id !== id) {
      activeProfile?.close();
      activeProfile = { id, close: hide };
    }
    openReason.current = reason;
    if (!open) setPosition(null);
    setOpen(true);
  }
  function closeLater() {
    cancelClose();
    if (position?.side === "sheet") return;
    timer.current = setTimeout(() => {
      if (
        popup.current?.contains(document.activeElement) ||
        (openedWithKeyboard.current &&
          document.activeElement === button.current)
      )
        return;
      hide();
    }, 150);
  }
  const closeAndReturn = useCallback(() => {
    hide();
    if (document.activeElement !== button.current) {
      returningFocus.current = true;
      button.current?.focus({ preventScroll: true });
    }
  }, [hide]);

  useLayoutEffect(() => {
    if (!open) return;
    const trigger = button.current;
    const panel = popup.current;
    if (!trigger || !panel) return;
    openingScroll.current.clear();
    for (
      let parent = trigger.parentElement;
      parent;
      parent = parent.parentElement
    )
      openingScroll.current.set(parent, {
        top: parent.scrollTop,
        left: parent.scrollLeft,
      });
    openingScroll.current.set(document, {
      top: window.scrollY,
      left: window.scrollX,
    });
    const anchor = trigger.getBoundingClientRect();
    const dimensions = panel.getBoundingClientRect();
    const fitsRight =
      anchor.right + profileGap + dimensions.width <=
      window.innerWidth - screenInset;
    const fitsLeft = anchor.left - profileGap - dimensions.width >= screenInset;
    const side = fitsRight ? "right" : fitsLeft ? "left" : "sheet";

    if (side === "sheet" && openReason.current === "hover") {
      setOpen(false);
      if (activeProfile?.id === id) activeProfile = null;
      return;
    }

    function align(height: number) {
      const top = Math.max(
        screenInset,
        Math.min(
          anchor.top + anchor.height / 2 - height / 2,
          window.innerHeight - screenInset - height,
        ),
      );
      const left =
        side === "right"
          ? anchor.right + profileGap
          : side === "left"
            ? anchor.left - profileGap - dimensions.width
            : screenInset;
      setPosition((current) =>
        current?.top === top && current.left === left && current.side === side
          ? current
          : { top, left, side },
      );
    }

    align(dimensions.height);
    const resize = new ResizeObserver(() => {
      align(panel.getBoundingClientRect().height);
    });
    resize.observe(panel);
    return () => resize.disconnect();
  }, [open, id]);

  useLayoutEffect(() => {
    if (
      open &&
      position?.side === "sheet" &&
      openReason.current === "press" &&
      !openedWithKeyboard.current
    )
      popup.current?.querySelector<HTMLButtonElement>("button")?.focus();
  }, [open, position?.side]);

  useEffect(() => {
    if (!open) return;
    function close(event: PointerEvent) {
      if (
        !button.current?.contains(event.target as Node) &&
        !popup.current?.contains(event.target as Node)
      )
        if (position?.side === "sheet") closeAndReturn();
        else hide();
    }
    function key(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        if (popup.current?.contains(document.activeElement)) closeAndReturn();
        else hide();
      }
    }
    function scroll(event: Event) {
      const target = event.target;
      if (popup.current?.contains(target as Node)) return;
      const before = target ? openingScroll.current.get(target) : undefined;
      const after =
        target === document
          ? { top: window.scrollY, left: window.scrollX }
          : target instanceof Element
            ? { top: target.scrollTop, left: target.scrollLeft }
            : null;
      // Focus may open after scrolling completes but before its event is delivered.
      if (before && after?.top === before.top && after.left === before.left)
        return;
      hide();
    }
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", key);
    document.addEventListener("scroll", scroll, true);
    window.addEventListener("resize", hide);
    return () => {
      cancelClose();
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", key);
      document.removeEventListener("scroll", scroll, true);
      window.removeEventListener("resize", hide);
    };
  }, [open, position?.side, cancelClose, closeAndReturn, hide]);

  useEffect(
    () => () => {
      cancelClose();
      if (activeProfile?.id === id) activeProfile = null;
    },
    [id, cancelClose],
  );

  return (
    <>
      <button
        ref={button}
        type="button"
        className="user-identity"
        onPointerEnter={(event) => {
          if (event.pointerType === "mouse") show("hover");
        }}
        onPointerLeave={closeLater}
        onFocus={(event) => {
          if (returningFocus.current) {
            returningFocus.current = false;
            return;
          }
          if (event.currentTarget.matches(":focus-visible")) {
            openedWithKeyboard.current = true;
            show("focus");
          }
        }}
        onBlur={(event) => {
          if (!popup.current?.contains(event.relatedTarget as Node))
            closeLater();
        }}
        onClick={(event) => {
          openedWithKeyboard.current = event.detail === 0;
          show("press");
          if (event.detail === 0)
            requestAnimationFrame(() =>
              popup.current?.querySelector<HTMLAnchorElement>("a")?.focus(),
            );
        }}
        onKeyDown={(event) => {
          if (open && event.key === "Tab" && !event.shiftKey) {
            event.preventDefault();
            popup.current?.querySelector<HTMLButtonElement>("button")?.focus();
          }
        }}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-controls={open ? id : undefined}
      >
        <Avatar name={name} color={color} />
        <span>{name}</span>
      </button>
      {open &&
        createPortal(
          <>
            {position?.side === "sheet" && (
              <div className="identity-sheet-backdrop" aria-hidden="true" />
            )}
            <div
              ref={popup}
              role="dialog"
              aria-label="用户资料"
              aria-modal={position?.side === "sheet" || undefined}
              id={id}
              className={`identity-popover identity-detail identity-detail--${position?.side ?? "right"}`}
              data-side={position?.side}
              style={
                position
                  ? position.side === "sheet"
                    ? undefined
                    : portalPosition(
                        portalTarget,
                        { top: position.top, left: position.left },
                        popup.current,
                      )
                  : { visibility: "hidden" }
              }
              onPointerEnter={cancelClose}
              onPointerLeave={closeLater}
              onFocus={cancelClose}
              onBlur={(event) => {
                if (!event.currentTarget.contains(event.relatedTarget as Node))
                  closeLater();
              }}
              onKeyDown={(event) => {
                if (position?.side !== "sheet" || event.key !== "Tab") return;
                const controls =
                  event.currentTarget.querySelectorAll<HTMLElement>(
                    "button, a[href]",
                  );
                const first = controls[0];
                const last = controls[controls.length - 1];
                if (event.shiftKey && document.activeElement === first) {
                  event.preventDefault();
                  last?.focus();
                } else if (!event.shiftKey && document.activeElement === last) {
                  event.preventDefault();
                  first?.focus();
                }
              }}
            >
              <button
                type="button"
                className="icon-button popover-close"
                aria-label="关闭资料"
                onClick={closeAndReturn}
                onKeyDown={(event) => {
                  if (
                    position?.side !== "sheet" &&
                    event.key === "Tab" &&
                    event.shiftKey
                  ) {
                    event.preventDefault();
                    button.current?.focus();
                  }
                }}
              >
                <X size={16} />
              </button>
              <div className="identity-detail__body">
                <Avatar name={name} color={color} large />
                <strong>{name}</strong>
                <span className="muted">@{username}</span>
                <a
                  href={`https://linux.do/u/${encodeURIComponent(username)}`}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  查看 Linux DO 主页 <ArrowUpRight size={15} />
                </a>
              </div>
            </div>
          </>,
          portalTarget,
        )}
    </>
  );
}
