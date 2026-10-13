import { Link } from "@tanstack/react-router";
import { Check, ChevronDown } from "lucide-react";
import {
  AnimatePresence,
  motion,
  useIsPresent,
  useReducedMotion,
} from "motion/react";
import {
  type CSSProperties,
  type KeyboardEvent,
  type RefObject,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import {
  type ActionFeedback,
  ActionFeedbackLabel,
} from "../ui/action-feedback";
import { type CopyAction, CopyButton } from "../ui/copy-button";
import { portalPosition, usePortalTarget } from "./portal-target";

export type ActionMenuItem = {
  label: string;
  copy?: CopyAction;
  feedback?: ActionFeedback | null;
  keepOpen?: boolean;
  reserve?: readonly string[];
  onSelect?: () => void;
  href?: string;
  selected?: boolean;
  disabled?: boolean;
};

export type ActionMenuProps = {
  label: string;
  items: readonly ActionMenuItem[];
  className?: string;
  ariaLabel?: string;
  disabled?: boolean;
};

const openEvent = "activity-action-menu-open";

export function ActionMenu({
  label,
  items,
  className,
  ariaLabel = label,
  disabled = false,
}: ActionMenuProps) {
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const portalTarget = usePortalTarget(trigger);
  const menu = useRef<HTMLDivElement>(null);
  const scrollPositions = useRef(
    new Map<Element, { top: number; left: number }>(),
  );
  const focusOnOpen = useRef<"first" | "last" | "selected">("selected");
  const placeMenu = useRef<(() => void) | null>(null);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<CSSProperties>({ top: 0, left: 0 });
  const close = useCallback((returnFocus = false) => {
    setOpen(false);
    if (returnFocus) trigger.current?.focus({ preventScroll: true });
  }, []);

  function show(focus: "first" | "last" | "selected" = "selected") {
    if (disabled) return;
    // A click can follow an auto-scroll whose event is still queued. Remember
    // the opening positions so that stale event does not dismiss the new menu.
    scrollPositions.current.clear();
    for (
      let parent = trigger.current?.parentElement;
      parent;
      parent = parent.parentElement
    ) {
      scrollPositions.current.set(parent, {
        top: parent.scrollTop,
        left: parent.scrollLeft,
      });
    }
    focusOnOpen.current = focus;
    document.dispatchEvent(new CustomEvent(openEvent, { detail: id }));
    setOpen(true);
  }

  useEffect(() => {
    const anotherMenu = (event: Event) => {
      if ((event as CustomEvent<string>).detail !== id) close();
    };
    document.addEventListener(openEvent, anotherMenu);
    return () => document.removeEventListener(openEvent, anotherMenu);
  }, [id, close]);

  useLayoutEffect(() => {
    if (!open) return;
    function place() {
      const button = trigger.current;
      const panel = menu.current;
      if (!button || !panel) return;
      const viewport = window.visualViewport;
      const offsetTop = viewport?.offsetTop ?? 0;
      const offsetLeft = viewport?.offsetLeft ?? 0;
      const width = viewport?.width ?? window.innerWidth;
      const height = viewport?.height ?? window.innerHeight;
      const anchor = button.getBoundingClientRect();
      const bounds = panel.getBoundingClientRect();
      const panelWidth = Math.min(bounds.width, Math.max(0, width - 24));
      const panelHeight = Math.min(bounds.height, Math.max(0, height - 24));
      const right = offsetLeft + width - 12;
      const bottom = offsetTop + height - 12;
      const top = Math.max(
        offsetTop + 12,
        Math.min(
          anchor.bottom + 6 + panelHeight <= bottom
            ? anchor.bottom + 6
            : anchor.top - panelHeight - 6,
          bottom - panelHeight,
        ),
      );
      const left = Math.max(
        offsetLeft + 12,
        Math.min(anchor.left, right - panelWidth),
      );
      setPosition({
        top,
        left,
        minWidth: Math.min(172, Math.max(0, width - 24)),
        maxWidth: Math.max(0, width - 24),
        maxHeight: Math.max(0, height - 24),
      });
    }
    placeMenu.current = place;
    place();
    const controls = menu.current
      ? Array.from(
          menu.current.querySelectorAll<HTMLElement>(
            "button:not(:disabled), a[href]",
          ),
        )
      : [];
    const selected = controls.find(
      (control) => control.dataset.selected === "true",
    );
    const initial =
      focusOnOpen.current === "last"
        ? controls.at(-1)
        : focusOnOpen.current === "selected"
          ? (selected ?? controls[0])
          : controls[0];
    (initial ?? menu.current)?.focus({ preventScroll: true });
    const observer = new ResizeObserver(place);
    if (menu.current) observer.observe(menu.current);
    return () => {
      observer.disconnect();
      placeMenu.current = null;
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!trigger.current?.contains(target) && !menu.current?.contains(target))
        close();
    };
    const scrolled = (event: Event) => {
      if (menu.current?.contains(event.target as Node)) return;
      const target =
        event.target === document ? document.scrollingElement : event.target;
      if (target instanceof Element) {
        const before = scrollPositions.current.get(target);
        if (
          before &&
          before.top === target.scrollTop &&
          before.left === target.scrollLeft
        )
          return;
        // A restored page, focus or scrollIntoView may move the main scroller
        // while this menu remains visible. Follow its anchor instead of closing
        // the menu immediately before the user can activate an item.
        if (
          event.type === "scroll" &&
          target.matches(".site-main") &&
          trigger.current &&
          target.contains(trigger.current)
        ) {
          const anchor = trigger.current.getBoundingClientRect();
          const bounds = target.getBoundingClientRect();
          const viewport = window.visualViewport;
          const top = Math.max(bounds.top, viewport?.offsetTop ?? 0);
          const left = Math.max(bounds.left, viewport?.offsetLeft ?? 0);
          const bottom = Math.min(
            bounds.bottom,
            (viewport?.offsetTop ?? 0) +
              (viewport?.height ?? window.innerHeight),
          );
          const right = Math.min(
            bounds.right,
            (viewport?.offsetLeft ?? 0) +
              (viewport?.width ?? window.innerWidth),
          );
          if (
            anchor.bottom > top &&
            anchor.top < bottom &&
            anchor.right > left &&
            anchor.left < right
          ) {
            scrollPositions.current.set(target, {
              top: target.scrollTop,
              left: target.scrollLeft,
            });
            placeMenu.current?.();
            return;
          }
        }
      }
      close(Boolean(menu.current?.contains(document.activeElement)));
    };
    const onEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      close(true);
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("scroll", scrolled, true);
    document.addEventListener("keydown", onEscape);
    window.addEventListener("resize", scrolled);
    window.visualViewport?.addEventListener("resize", scrolled);
    window.visualViewport?.addEventListener("scroll", scrolled);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("scroll", scrolled, true);
      document.removeEventListener("keydown", onEscape);
      window.removeEventListener("resize", scrolled);
      window.visualViewport?.removeEventListener("resize", scrolled);
      window.visualViewport?.removeEventListener("scroll", scrolled);
    };
  }, [open, close]);

  return (
    <div className={`action-menu${className ? ` ${className}` : ""}`}>
      <button
        ref={trigger}
        type="button"
        className="action-menu-trigger"
        aria-label={ariaLabel}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        disabled={disabled}
        onPointerDown={(event) => event.stopPropagation()}
        onClick={(event) => {
          event.stopPropagation();
          if (open) close();
          else show();
        }}
        onKeyDown={(event) => {
          if (["ArrowDown", "ArrowUp"].includes(event.key)) {
            event.preventDefault();
            event.stopPropagation();
            show(event.key === "ArrowUp" ? "last" : "first");
          }
        }}
      >
        <span>{label}</span>
        <ChevronDown size={16} aria-hidden="true" />
      </button>
      {createPortal(
        <AnimatePresence>
          {open && (
            <ActionMenuPanel
              key={id}
              id={id}
              label={ariaLabel}
              menuRef={menu}
              items={items}
              position={portalPosition(portalTarget, position, menu.current)}
              close={close}
            />
          )}
        </AnimatePresence>,
        portalTarget,
      )}
    </div>
  );
}

function ActionMenuPanel({
  id,
  label,
  menuRef,
  items,
  position,
  close,
}: {
  id: string;
  label: string;
  menuRef: RefObject<HTMLDivElement | null>;
  items: readonly ActionMenuItem[];
  position: CSSProperties;
  close: (returnFocus?: boolean) => void;
}) {
  const present = useIsPresent();
  const reducedMotion = useReducedMotion();

  function keyboard(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close(true);
      return;
    }
    if (event.key === "Tab") {
      close(true);
      return;
    }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    event.stopPropagation();
    const controls = Array.from(
      event.currentTarget.querySelectorAll<HTMLElement>(
        "button:not(:disabled), a[href]",
      ),
    );
    const index = controls.indexOf(document.activeElement as HTMLElement);
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? controls.length - 1
          : (index + (event.key === "ArrowDown" ? 1 : -1) + controls.length) %
            controls.length;
    controls[next]?.focus({ preventScroll: true });
    controls[next]?.scrollIntoView({ block: "nearest" });
  }

  return (
    <motion.div
      ref={menuRef}
      id={id}
      role="menu"
      aria-label={label}
      aria-hidden={!present}
      inert={!present}
      className="action-menu-panel"
      tabIndex={-1}
      style={{ ...position, pointerEvents: present ? "auto" : "none" }}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: reducedMotion ? 0 : 0.15 }}
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
      onKeyDown={keyboard}
    >
      {items.map((item) =>
        item.copy ? (
          <CopyButton
            key={item.label}
            label={item.label}
            getText={item.copy.getText}
            scope={item.copy.scope}
            canCopy={() => present && item.copy?.canCopy?.() !== false}
            role="menuitem"
            className="action-menu-item"
            tabIndex={-1}
            disabled={item.disabled}
          />
        ) : item.href && !item.disabled ? (
          <Link
            key={item.label}
            to={item.href}
            role="menuitem"
            className="action-menu-item"
            tabIndex={-1}
            onClick={() => {
              if (!item.keepOpen) close(true);
              item.onSelect?.();
            }}
          >
            <span>{item.label}</span>
          </Link>
        ) : (
          <button
            key={item.label}
            type="button"
            {...(typeof item.selected === "boolean"
              ? { role: "menuitemradio", "aria-checked": item.selected }
              : { role: "menuitem" })}
            data-selected={item.selected}
            className="action-menu-item"
            aria-label={
              item.feedback
                ? `${item.label}，${item.feedback.label}`
                : undefined
            }
            title={item.feedback?.detail}
            aria-description={item.feedback?.detail}
            tabIndex={-1}
            disabled={item.disabled}
            onClick={() => {
              if (!item.keepOpen) close(true);
              item.onSelect?.();
            }}
          >
            {"feedback" in item ? (
              <ActionFeedbackLabel
                label={item.label}
                feedback={item.feedback}
                reserve={item.reserve}
              />
            ) : (
              <span>{item.label}</span>
            )}
            {item.selected && <Check size={16} aria-hidden="true" />}
          </button>
        ),
      )}
    </motion.div>
  );
}
