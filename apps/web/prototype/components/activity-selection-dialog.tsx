import { X } from "lucide-react";
import { useIsPresent } from "motion/react";
import { type PointerEvent, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { getActivityPublicMetadata } from "../activity-metadata";
import type {
  Activity,
  ActivityViewStateOverrides,
  Participation,
} from "../types";
import { activityRewardSummary, projectActivityViewState } from "../view-state";
import {
  ActivityRowTitle,
  projectActivityTableState,
} from "./compact-activity-table";
import { CompactIconButton } from "./compact-icon-button";
import { UserIdentity } from "./identity";
import { Pagination, usePagination } from "./list-controls";
import { PortalTargetProvider } from "./portal-target";
import "./activity-selection-dialog.css";

export function ActivitySelectionDialog({
  title,
  items,
  onClose,
  onOpen,
  records,
  states,
  fuzzy = false,
  restoreFocus,
}: {
  title: string;
  items: Activity[];
  onClose: () => void;
  onOpen: (activity: Activity) => void;
  records: Record<string, Participation>;
  states: Record<string, ActivityViewStateOverrides>;
  fuzzy?: boolean;
  restoreFocus?: HTMLElement | null;
}) {
  const [dialog, setDialog] = useState<HTMLDialogElement | null>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const opener = useRef<Element | null>(null);
  const handled = useRef(false);
  const backdropPress = useRef(false);
  const scroll = useRef<HTMLUListElement>(null);
  const present = useIsPresent();
  const paging = usePagination(items, items.map((item) => item.id).join(","));

  useLayoutEffect(() => {
    if (!dialog || !present) return;
    opener.current = restoreFocus ?? document.activeElement;
    dialog.showModal();
    closeButton.current?.focus({ preventScroll: true });
    return () => dialog.close();
  }, [dialog, present, restoreFocus]);

  function close(activity?: Activity) {
    if (handled.current || !present || !dialog?.open) return;
    handled.current = true;
    // Release the native top layer synchronously before navigation measures
    // the home illustration. No delayed selection survives route changes.
    dialog.close();
    if (activity) onOpen(activity);
    else {
      onClose();
      if (opener.current instanceof HTMLElement && opener.current.isConnected)
        opener.current.focus({ preventScroll: true });
    }
  }

  function isBackdrop(event: PointerEvent<HTMLDialogElement>) {
    if (event.target !== event.currentTarget) return false;
    const bounds = event.currentTarget.getBoundingClientRect();
    return (
      event.clientX < bounds.left ||
      event.clientX > bounds.right ||
      event.clientY < bounds.top ||
      event.clientY > bounds.bottom
    );
  }

  if (!present) return null;
  return createPortal(
    <dialog
      ref={setDialog}
      className="activity-selection-dialog"
      aria-label={title}
      onKeyDown={(event) => {
        if (event.key !== "Tab" || event.defaultPrevented) return;
        const controls = Array.from(
          event.currentTarget.querySelectorAll<HTMLElement>(
            'button:not(:disabled), a[href], [tabindex="0"]',
          ),
        ).filter(
          (node) => node.offsetParent !== null && !node.closest("[inert]"),
        );
        const first = controls[0];
        const last = controls.at(-1);
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first?.focus();
        }
      }}
      onCancel={(event) => {
        event.preventDefault();
        close();
      }}
      onPointerDown={(event) => {
        backdropPress.current = isBackdrop(event);
      }}
      onPointerUp={(event) => {
        if (backdropPress.current && isBackdrop(event)) close();
        backdropPress.current = false;
      }}
    >
      <PortalTargetProvider target={dialog}>
        <header className="activity-selection-header">
          <div>
            <h2>{title}</h2>
            <span className="muted">{items.length} 个匹配</span>
          </div>
          <CompactIconButton
            ref={closeButton}
            aria-label="关闭选择活动"
            onClick={() => close()}
          >
            <X size={16} aria-hidden="true" />
          </CompactIconButton>
        </header>
        <ul
          className="activity-selection-list"
          ref={scroll}
          aria-label="匹配活动"
        >
          {paging.pageItems.map((activity) => {
            const metadata = getActivityPublicMetadata(activity, { fuzzy });
            const state = projectActivityTableState(
              activity,
              projectActivityViewState(
                activity,
                records[activity.id],
                states[activity.id],
              ),
            );
            return (
              <li key={activity.id}>
                <ActivityRowTitle
                  activity={activity}
                  state={state}
                  onOpen={() => close(activity)}
                >
                  <UserIdentity
                    name={activity.author}
                    username={activity.username}
                    color={activity.color}
                  />
                </ActivityRowTitle>
                <div className="activity-selection-reward">
                  <span>{metadata.rewardLabel}</span>
                  <strong>
                    {activityRewardSummary(activity) ?? metadata.countLabel}
                  </strong>
                </div>
              </li>
            );
          })}
        </ul>
        <Pagination
          label={`${title}分页`}
          page={paging.page}
          hasNext={paging.hasNext}
          onPageChange={(next) => {
            paging.setPage(next);
            if (scroll.current) scroll.current.scrollTop = 0;
          }}
        />
      </PortalTargetProvider>
    </dialog>,
    document.body,
  );
}
