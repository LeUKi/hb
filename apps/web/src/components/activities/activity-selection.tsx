import type { DiscoveryCard } from "@hb/contracts";
import { X } from "lucide-react";
import { useIsPresent } from "motion/react";
import {
  type PointerEvent,
  type ReactNode,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { useRestoredScroll } from "../../lib/navigation-state";
import {
  ActivityRowTitle,
  rewardKindLabel,
  rewardMainText,
} from "../presentation/activity-list";
import { CompactIconButton } from "../presentation/compact-icon-button";
import { Pagination } from "../presentation/list-controls";
import { SkeletonRows } from "../presentation/loading";
import { PortalTargetProvider } from "../presentation/portal-target";
import { UserIdentity } from "../user-identity";

export function ActivitySelection({
  title,
  items,
  total,
  pending,
  error,
  retry,
  refreshNotice,
  cursors,
  setCursors,
  nextCursor,
  onClose,
  onSelect,
  restoreFocus,
}: {
  title: string;
  items: DiscoveryCard[];
  total?: number;
  pending: boolean;
  error?: Error | null;
  retry: () => void;
  refreshNotice?: ReactNode;
  cursors: Array<string | null>;
  setCursors: (c: Array<string | null>) => void;
  nextCursor: string | null;
  onClose: (selected?: boolean) => void;
  onSelect: (id: string) => void;
  restoreFocus?: HTMLElement | null;
}) {
  const [dialog, setDialog] = useState<HTMLDialogElement | null>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const opener = useRef<Element | null>(null);
  const handled = useRef(false);
  const backdropPress = useRef(false);
  const scroll = useRef<HTMLUListElement>(null);
  const present = useIsPresent();
  useRestoredScroll(
    scroll,
    `selection:${title}`,
    !pending,
    String(cursors.length),
  );
  const [recordHeight, setRecordHeight] = useState<number>();
  useLayoutEffect(() => {
    if (pending || error || !scroll.current) return;
    const node = scroll.current;
    const measure = () => setRecordHeight(node.getBoundingClientRect().height);
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    measure();
    return () => observer.disconnect();
  }, [pending, error]);

  useLayoutEffect(() => {
    if (!dialog || !present) return;
    opener.current = restoreFocus ?? document.activeElement;
    dialog.showModal();
    closeButton.current?.focus({ preventScroll: true });
    return () => dialog.close();
  }, [dialog, present, restoreFocus]);

  function close(activity?: DiscoveryCard) {
    if (handled.current || !present || !dialog?.open) return;
    handled.current = true;
    // Release the native top layer synchronously before navigation measures
    // the home illustration. No delayed selection survives route changes.
    dialog.close();
    onClose(Boolean(activity));
    if (activity) onSelect(activity.id);
    else {
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
            <span className="muted">
              {total === undefined && (cursors.length > 1 || nextCursor)
                ? "本页 "
                : ""}
              {pending || error ? "—" : (total ?? items.length)} 个匹配
            </span>
          </div>
          <CompactIconButton
            ref={closeButton}
            aria-label="关闭选择活动"
            onClick={() => close()}
          >
            <X size={16} aria-hidden="true" />
          </CompactIconButton>
        </header>
        {refreshNotice}
        <ul
          className="activity-selection-list"
          ref={scroll}
          aria-label="匹配活动"
          aria-busy={pending}
          style={pending || error ? { minHeight: recordHeight } : undefined}
        >
          {pending && (
            <li>
              <span role="status" className="sr-only">
                正在读取匹配结果…
              </span>
              <SkeletonRows />
            </li>
          )}
          {error && !pending && (
            <li role="alert">
              <p>{error.message}</p>
              <button className="text-button" type="button" onClick={retry}>
                重试
              </button>
            </li>
          )}
          {!pending &&
            !error &&
            items.map((activity) => (
              <li key={activity.id}>
                <ActivityRowTitle
                  title={activity.title}
                  status={activity.status}
                  deadlineAt={activity.deadlineAt}
                  draw={activity.draw}
                  onOpen={() => close(activity)}
                >
                  <UserIdentity profile={activity.author} />
                </ActivityRowTitle>
                <div className="activity-selection-reward">
                  <span>{rewardKindLabel(activity.reward)}</span>
                  <strong>{rewardMainText(activity.reward)}</strong>
                </div>
              </li>
            ))}
        </ul>
        <Pagination
          label={`${title}分页`}
          page={cursors.length}
          hasNext={Boolean(nextCursor)}
          busy={pending}
          onPageChange={(next) => {
            if (next < cursors.length) setCursors(cursors.slice(0, -1));
            else if (nextCursor) setCursors([...cursors, nextCursor]);
            if (scroll.current) scroll.current.scrollTop = 0;
          }}
        />
      </PortalTargetProvider>
    </dialog>,
    document.body,
  );
}
