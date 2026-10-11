import { CircleHelp, X } from "lucide-react";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { CompactIconButton } from "./compact-icon-button";
import { portalPosition, usePortalTarget } from "./portal-target";

const openEvent = "activity-help-open";

export function Help({
  label,
  children,
  icon,
  className,
}: {
  label: string;
  children: ReactNode;
  icon?: ReactNode;
  className?: string;
}) {
  const id = useId();
  const helpLabel = label.endsWith("说明") ? label : `${label}说明`;
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ top: 0, left: 0 });
  const trigger = useRef<HTMLButtonElement>(null);
  const portalTarget = usePortalTarget(trigger);
  const popup = useRef<HTMLDivElement>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pinned = useRef(false);
  const returningFocus = useRef(false);

  const cancelClose = useCallback(() => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
    closeTimer.current = null;
  }, []);

  const hide = useCallback(
    (returnFocus = false) => {
      cancelClose();
      pinned.current = false;
      setOpen(false);
      if (returnFocus && document.activeElement !== trigger.current) {
        returningFocus.current = true;
        trigger.current?.focus({ preventScroll: true });
      }
    },
    [cancelClose],
  );

  function show() {
    cancelClose();
    document.dispatchEvent(new CustomEvent(openEvent, { detail: id }));
    setOpen(true);
  }

  function closeLater() {
    if (pinned.current) return;
    cancelClose();
    closeTimer.current = setTimeout(() => setOpen(false), 160);
  }

  useEffect(() => {
    function anotherHelp(event: Event) {
      if ((event as CustomEvent<string>).detail === id) return;
      cancelClose();
      pinned.current = false;
      setOpen(false);
    }
    document.addEventListener(openEvent, anotherHelp);
    return () => {
      cancelClose();
      document.removeEventListener(openEvent, anotherHelp);
    };
  }, [id, cancelClose]);

  useLayoutEffect(() => {
    if (!open) return;
    function place() {
      const button = trigger.current;
      const panel = popup.current;
      if (!button || !panel) return;
      const rect = button.getBoundingClientRect();
      const viewport = window.visualViewport;
      const offsetTop = viewport?.offsetTop ?? 0;
      const offsetLeft = viewport?.offsetLeft ?? 0;
      const width = viewport?.width ?? window.innerWidth;
      const height = viewport?.height ?? window.innerHeight;
      const bounds = panel.getBoundingClientRect();
      const bottom = offsetTop + height - 12;
      const left = Math.max(
        offsetLeft + 12,
        Math.min(rect.left, offsetLeft + width - bounds.width - 12),
      );
      const preferredTop = rect.bottom + 8;
      const top = Math.max(
        offsetTop + 12,
        Math.min(
          preferredTop + bounds.height <= bottom
            ? preferredTop
            : rect.top - bounds.height - 8,
          bottom - bounds.height,
        ),
      );
      setPosition((current) =>
        current.top === top && current.left === left ? current : { top, left },
      );
    }
    place();
    const observer = new ResizeObserver(place);
    if (popup.current) observer.observe(popup.current);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    window.visualViewport?.addEventListener("resize", place);
    window.visualViewport?.addEventListener("scroll", place);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
      window.visualViewport?.removeEventListener("resize", place);
      window.visualViewport?.removeEventListener("scroll", place);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function outside(event: PointerEvent) {
      const target = event.target as Node;
      if (
        !trigger.current?.contains(target) &&
        !popup.current?.contains(target)
      )
        hide();
    }
    function onEscape(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        hide(Boolean(popup.current?.contains(document.activeElement)));
      }
    }
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", onEscape);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", onEscape);
    };
  }, [open, hide]);

  return (
    <span className="context-help">
      <CompactIconButton
        ref={trigger}
        className={`context-help-trigger${className ? ` ${className}` : ""}`}
        aria-label={helpLabel}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onMouseEnter={show}
        onMouseLeave={closeLater}
        onFocus={() => {
          if (returningFocus.current) {
            returningFocus.current = false;
            return;
          }
          show();
        }}
        onBlur={(event) => {
          if (!popup.current?.contains(event.relatedTarget as Node))
            closeLater();
        }}
        onPointerDown={(event) => event.stopPropagation()}
        onClick={(event) => {
          event.stopPropagation();
          if (pinned.current) {
            hide();
            return;
          }
          pinned.current = true;
          show();
          if (event.detail === 0)
            requestAnimationFrame(() =>
              popup.current
                ?.querySelector<HTMLButtonElement>("button")
                ?.focus(),
            );
        }}
        onKeyDown={(event) => {
          if (["Enter", " ", "Escape"].includes(event.key))
            event.stopPropagation();
          if (event.key === "Escape") {
            event.preventDefault();
            hide();
          }
        }}
      >
        {icon ?? <CircleHelp size={15} aria-hidden="true" />}
      </CompactIconButton>
      {open &&
        createPortal(
          <div
            ref={popup}
            id={id}
            role="dialog"
            aria-label={helpLabel}
            className="context-help-popover"
            style={portalPosition(portalTarget, position, popup.current)}
            onMouseEnter={cancelClose}
            onMouseLeave={closeLater}
            onFocus={cancelClose}
            onBlur={(event) => {
              if (
                !event.currentTarget.contains(event.relatedTarget as Node) &&
                event.relatedTarget !== trigger.current
              ) {
                pinned.current = false;
                closeLater();
              }
            }}
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => event.stopPropagation()}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                hide(true);
              }
            }}
          >
            <div className="context-help-heading">
              <strong>{label}</strong>
              <CompactIconButton
                className="context-help-close"
                aria-label="关闭说明"
                onClick={() => hide(true)}
                onKeyDown={(event) => {
                  if (event.key === "Tab" && event.shiftKey) {
                    event.preventDefault();
                    returningFocus.current = true;
                    trigger.current?.focus({ preventScroll: true });
                  }
                }}
              >
                <X size={16} aria-hidden="true" />
              </CompactIconButton>
            </div>
            <div className="context-help-content">{children}</div>
          </div>,
          portalTarget,
        )}
    </span>
  );
}
