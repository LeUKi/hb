import { MoreHorizontal } from "lucide-react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { portalPosition, usePortalTarget } from "./portal-target";
import { ViewActivityAction } from "./view-activity-action";
import "./row-actions.css";

export type RowAction = {
  label: string;
  onSelect?: () => void;
  activityId?: string;
  danger?: boolean;
  disabled?: boolean;
};

function actionClass(action: RowAction, primary = false) {
  return [
    "row-action",
    primary ? "row-action-primary" : "",
    action.danger ? "row-action--danger" : "",
  ]
    .filter(Boolean)
    .join(" ");
}

function ActionControl({
  action,
  ariaLabel,
  role,
  primary = false,
  onClick,
}: {
  action: RowAction;
  ariaLabel?: string;
  role?: "menuitem";
  primary?: boolean;
  onClick?: () => void;
}) {
  const className = actionClass(action, primary);
  const invoke = () => {
    onClick?.();
    action.onSelect?.();
  };
  if (action.activityId && !action.disabled)
    return (
      <ViewActivityAction
        activityId={action.activityId}
        className={className}
        aria-label={ariaLabel}
        role={role}
        onClick={onClick}
      />
    );
  return (
    <button
      type="button"
      className={className}
      aria-label={ariaLabel}
      role={role}
      disabled={action.disabled}
      onClick={invoke}
    >
      {action.label}
    </button>
  );
}

export function RowActions({
  label,
  actions,
}: {
  label: string;
  actions: RowAction[];
}) {
  const [open, setOpen] = useState(false);
  const [compact, setCompact] = useState(
    () => window.matchMedia("(max-width: 760px)").matches,
  );
  const reducedMotion = useReducedMotion();
  const [position, setPosition] = useState({ top: 0, left: 0 });
  const trigger = useRef<HTMLButtonElement>(null);
  const portalTarget = usePortalTarget(trigger);
  const menu = useRef<HTMLDivElement>(null);
  const id = useId();
  const primary = actions[0];
  const desktopActions = actions;
  const menuActions = compact ? actions.slice(1) : [];
  const ordinary = menuActions.filter((action) => !action.danger);
  const dangerous = menuActions.filter((action) => action.danger);

  function close(returnFocus = false) {
    setOpen(false);
    if (returnFocus) trigger.current?.focus({ preventScroll: true });
  }

  useEffect(() => {
    const media = window.matchMedia("(max-width: 760px)");
    const update = () => {
      setCompact(media.matches);
      setOpen(false);
    };
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  useLayoutEffect(() => {
    if (!open || !trigger.current || !menu.current) return;
    const anchor = trigger.current.getBoundingClientRect();
    const dimensions = menu.current.getBoundingClientRect();
    setPosition({
      left: Math.max(
        12,
        Math.min(
          anchor.right - dimensions.width,
          window.innerWidth - dimensions.width - 12,
        ),
      ),
      top: Math.max(
        12,
        Math.min(
          anchor.bottom + dimensions.height + 6 <= window.innerHeight - 12
            ? anchor.bottom + 6
            : anchor.top - dimensions.height - 6,
          window.innerHeight - dimensions.height - 12,
        ),
      ),
    });
    const first = menu.current.querySelector<HTMLElement>(
      "button:not(:disabled), a[href]",
    );
    (first ?? menu.current).focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const hide = (event: Event) => {
      if (
        event.type === "pointerdown" &&
        (trigger.current?.contains(event.target as Node) ||
          menu.current?.contains(event.target as Node))
      )
        return;
      if (
        event.type === "scroll" &&
        menu.current?.contains(event.target as Node)
      )
        return;
      setOpen(false);
    };
    document.addEventListener("pointerdown", hide);
    document.addEventListener("scroll", hide, true);
    window.addEventListener("resize", hide);
    return () => {
      document.removeEventListener("pointerdown", hide);
      document.removeEventListener("scroll", hide, true);
      window.removeEventListener("resize", hide);
    };
  }, [open]);

  return (
    <div className="row-actions">
      <div className="row-actions-inline">
        {desktopActions.map((action) => (
          <ActionControl
            key={action.label}
            ariaLabel={`${label}：${action.label}`}
            action={action}
          />
        ))}
      </div>
      {primary && (
        <ActionControl
          ariaLabel={`${label}：${primary.label}`}
          action={primary}
          primary
        />
      )}
      {menuActions.length > 0 && (
        <button
          ref={trigger}
          type="button"
          className={`row-menu-trigger${!compact ? " row-menu-trigger--desktop" : ""}`}
          aria-label={`${label}操作`}
          aria-haspopup="menu"
          aria-expanded={open}
          aria-controls={open ? id : undefined}
          onClick={() => setOpen(!open)}
        >
          <MoreHorizontal size={19} aria-hidden="true" />
        </button>
      )}
      {createPortal(
        <AnimatePresence>
          {open && (
            <motion.div
              ref={menu}
              role="menu"
              id={id}
              aria-label={`${label}操作`}
              className="row-action-menu"
              style={portalPosition(portalTarget, position, menu.current)}
              tabIndex={-1}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: reducedMotion ? 0 : 0.15 }}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.preventDefault();
                  close(true);
                  return;
                }
                const controls = Array.from(
                  event.currentTarget.querySelectorAll<HTMLElement>(
                    "button:not(:disabled), a[href]",
                  ),
                );
                const index = controls.indexOf(
                  document.activeElement as HTMLElement,
                );
                if (
                  ["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)
                ) {
                  event.preventDefault();
                  const next =
                    event.key === "Home"
                      ? 0
                      : event.key === "End"
                        ? controls.length - 1
                        : (index +
                            (event.key === "ArrowDown" ? 1 : -1) +
                            controls.length) %
                          controls.length;
                  controls[next]?.focus();
                } else if (event.key === "Tab") {
                  close(true);
                }
              }}
            >
              {ordinary.map((action) => (
                <ActionControl
                  key={action.label}
                  action={action}
                  role="menuitem"
                  onClick={() => {
                    close();
                  }}
                />
              ))}
              {ordinary.length > 0 && dangerous.length > 0 && (
                <hr className="row-action-separator" />
              )}
              {dangerous.map((action) => (
                <ActionControl
                  key={action.label}
                  action={action}
                  role="menuitem"
                  onClick={() => {
                    close();
                  }}
                />
              ))}
            </motion.div>
          )}
        </AnimatePresence>,
        portalTarget,
      )}
    </div>
  );
}
