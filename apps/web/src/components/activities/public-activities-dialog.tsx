import { useSetAtom } from "jotai";
import { X } from "lucide-react";
import { useIsPresent } from "motion/react";
import {
  type PointerEvent,
  type RefObject,
  type SetStateAction,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { useSession } from "../../lib/auth";
import { exchangeContextAtom, useDiscovery } from "../../lib/discovery";
import { useCursorRecovery, useViewState } from "../../lib/navigation-state";
import { listQueryState } from "../../lib/query-view";
import { redemptionIntentAtom } from "../../lib/redemption-intent";
import { ActionMenu } from "../presentation/action-menu";
import { CompactIconButton } from "../presentation/compact-icon-button";
import {
  ListPanel,
  ListRefreshButton,
  Pagination,
} from "../presentation/list-controls";
import { RefreshNotice } from "../presentation/loading";
import { PortalTargetProvider } from "../presentation/portal-target";
import { ActivityErrorView } from "./activity-error";
import { DiscoveryCards } from "./discovery-cards";

export type SquareStatus = "all" | "active" | "ended";
type ScopedCursors = { scope: string; cursors: Array<string | null> };

export function PublicActivitiesDialog({
  status,
  onStatusChange,
  onClose,
  restoreFocus,
}: {
  status: SquareStatus;
  onStatusChange: (value: SquareStatus) => void;
  onClose: () => void;
  restoreFocus: HTMLElement | null;
}) {
  const session = useSession();
  const [dialog, setDialog] = useState<HTMLDialogElement | null>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const backdropPress = useRef(false);
  const navigating = useRef(false);
  const focusTarget = useRef(restoreFocus);
  focusTarget.current = restoreFocus ?? focusTarget.current;
  const present = useIsPresent();
  const setIntent = useSetAtom(redemptionIntentAtom);
  const setContext = useSetAtom(exchangeContextAtom);
  const [savedFocus, setSavedFocus] = useViewState("public-activities-focus", {
    row: "",
    index: 0,
  });
  useLayoutEffect(() => {
    if (!dialog || !present) return;
    dialog.showModal();
    closeButton.current?.focus({ preventScroll: true });
    return () => {
      dialog.close();
      const target =
        focusTarget.current ??
        document.getElementById("public-activities-trigger");
      if (!navigating.current && target?.isConnected)
        target.focus({ preventScroll: true });
    };
  }, [dialog, present]);
  useEffect(() => {
    if (!dialog || !present || !savedFocus.row) return;
    const restore = () => {
      const row = Array.from(
        dialog.querySelectorAll<HTMLElement>("[data-activity-id]"),
      ).find((node) => node.dataset.activityId === savedFocus.row);
      const control =
        row?.querySelectorAll<HTMLElement>("a,button")[savedFocus.index];
      if (!control || !dialog.open) return false;
      control.focus({ preventScroll: true });
      return true;
    };
    if (restore()) return;
    const observer = new MutationObserver(() => {
      if (restore()) observer.disconnect();
    });
    observer.observe(dialog, { childList: true, subtree: true });
    const stop = () => observer.disconnect();
    dialog.addEventListener("pointerdown", stop, { once: true });
    dialog.addEventListener("keydown", stop, { once: true });
    return () => {
      observer.disconnect();
      dialog.removeEventListener("pointerdown", stop);
      dialog.removeEventListener("keydown", stop);
    };
  }, [dialog, present, savedFocus]);
  function close() {
    dialog?.close();
    onClose();
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
      className="public-activities-dialog"
      aria-label="活动广场"
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
        {session.isError ? (
          <>
            <header className="page-title">
              <h2>活动广场</h2>
              <CompactIconButton
                ref={closeButton}
                aria-label="关闭活动广场"
                onClick={close}
              >
                <X size={16} />
              </CompactIconButton>
            </header>
            <ActivityErrorView
              error={session.error}
              retry={() => session.refetch()}
            />
          </>
        ) : (
          <PublicActivityResults
            status={status}
            onStatusChange={onStatusChange}
            onClose={close}
            closeButton={closeButton}
            userId={session.data?.user?.id ?? null}
            identityKey={
              session.isPending
                ? "pending"
                : (session.data?.user?.id ?? "guest")
            }
            sessionPending={session.isPending}
            onNavigate={() => {
              const active = document.activeElement;
              const row = active?.closest<HTMLElement>("[data-activity-id]");
              if (row?.dataset.activityId) {
                const index = Array.from(
                  row.querySelectorAll("a,button"),
                ).indexOf(active as HTMLElement);
                if (index >= 0)
                  setSavedFocus({ row: row.dataset.activityId, index });
              }
              navigating.current = true;
              dialog?.close();
              setIntent(null);
              setContext((current) =>
                current?.state === "unconfirmed" ? current : null,
              );
            }}
          />
        )}
      </PortalTargetProvider>
    </dialog>,
    document.body,
  );
}

function PublicActivityResults({
  status,
  userId,
  identityKey,
  sessionPending,
  onStatusChange,
  onNavigate,
  onClose,
  closeButton,
}: {
  status: SquareStatus;
  userId: string | null;
  identityKey: string;
  sessionPending: boolean;
  onStatusChange: (value: SquareStatus) => void;
  onNavigate: () => void;
  onClose: () => void;
  closeButton: RefObject<HTMLButtonElement | null>;
}) {
  const cursorScope = `${identityKey}:${status}`;
  const [pager, setPager] = useViewState<ScopedCursors>("square-pager", {
    scope: cursorScope,
    cursors: [null],
  });
  const cursors = pager.scope === cursorScope ? pager.cursors : [null];
  const setCursors = useCallback(
    (value: SetStateAction<Array<string | null>>) => {
      setPager((current) => {
        const currentCursors =
          current.scope === cursorScope ? current.cursors : [null];
        const cursors =
          typeof value === "function" ? value(currentCursors) : value;
        return { scope: cursorScope, cursors };
      });
    },
    [cursorScope, setPager],
  );
  useEffect(() => {
    setPager((current) =>
      current.scope === cursorScope
        ? current
        : { scope: cursorScope, cursors: [null] },
    );
  }, [cursorScope, setPager]);
  const query = useDiscovery(
    status,
    cursors.at(-1) ?? null,
    userId,
    "all",
    !sessionPending,
  );
  const cursorNotice = useCursorRecovery(query.error, cursors, setCursors);
  const state = sessionPending ? "loading" : listQueryState(query);
  const total = query.data
    ? (query.data.total ?? query.data.items.length)
    : null;
  return (
    <section className="public-activities-list">
      <div className="page-title">
        <h2>活动广场</h2>
        <section className="history-statistics" aria-label="活动广场统计">
          <div data-statistic="public">
            <span>公开活动</span>
            <span className="history-statistics-value">
              {total ?? "—"}
              <small>场</small>
            </span>
          </div>
        </section>
        <CompactIconButton
          ref={closeButton}
          aria-label="关闭活动广场"
          onClick={onClose}
        >
          <X size={16} aria-hidden="true" />
        </CompactIconButton>
      </div>
      <div className="gallery-toolbar">
        <div className="gallery-status-filter">
          <ActionMenu
            label={`状态：${status === "all" ? "全部" : status === "active" ? "进行中" : "已结束"}`}
            ariaLabel="活动状态筛选"
            items={[
              {
                label: "全部",
                selected: status === "all",
                onSelect: () => onStatusChange("all"),
              },
              {
                label: "进行中",
                selected: status === "active",
                onSelect: () => onStatusChange("active"),
              },
              {
                label: "已结束",
                selected: status === "ended",
                onSelect: () => onStatusChange("ended"),
              },
            ]}
          />
          {status !== "all" ? (
            <CompactIconButton
              aria-label="清空状态筛选"
              onClick={() => onStatusChange("all")}
            >
              <X size={16} />
            </CompactIconButton>
          ) : null}
        </div>
        <ListRefreshButton
          busy={sessionPending || query.isFetching}
          onRefresh={() => void query.refetch()}
        />
      </div>
      {cursorNotice}
      <ListPanel
        restorationId="square"
        keepContent
        refreshState={{
          fetching: query.isFetching,
          updatedAt: query.dataUpdatedAt,
          error: query.isError,
        }}
        state={state}
        emptyText="暂无符合条件的活动。"
        onRetry={query.isError ? () => query.refetch() : undefined}
        refreshNotice={<RefreshNotice query={query} />}
        resetKey={`${status}:${cursors.length}`}
        footer={
          <Pagination
            label="活动广场分页"
            page={cursors.length}
            hasNext={Boolean(query.data?.nextCursor)}
            onPageChange={(page) => {
              if (page < cursors.length) setCursors(cursors.slice(0, -1));
              else if (query.data?.nextCursor)
                setCursors([...cursors, query.data.nextCursor]);
            }}
            busy={state === "loading"}
          />
        }
      >
        <DiscoveryCards
          onNavigate={onNavigate}
          items={query.data?.items ?? []}
          state={state}
          emptyText="暂无符合条件的活动。"
          errorContent={
            query.isError ? (
              <ActivityErrorView
                error={query.error}
                retry={() => query.refetch()}
              />
            ) : undefined
          }
          onRetry={query.isError ? () => query.refetch() : undefined}
        />
      </ListPanel>
    </section>
  );
}
