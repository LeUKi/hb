import { X } from "lucide-react";
import {
  type PointerEvent,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import type { RecipientExample } from "../fixtures";
import { recipientTitles } from "../recipient-titles";
import {
  appendRosterRows,
  type RosterBatch,
  type RosterRecord,
  readRosterBatch,
  rosterRecords,
} from "../roster-cursor";
import { RelativeTime, ShortTime } from "../time";
import type { Activity, DrawProgress, Identity } from "../types";
import { CompactIconButton } from "./compact-icon-button";
import { Avatar, UserIdentity } from "./identity";
import { SegmentedControl } from "./list-controls";
import { PortalTargetProvider } from "./portal-target";
import "./public-roster.css";

type RosterTab = "registrations" | "winners";
type ListState = "ready" | "loading" | "error";
const noRecords: readonly RecipientExample[] = [];
const noRosterRecords: readonly RosterRecord[] = [];

function useRosterRecords(
  rows: readonly Readonly<RecipientExample>[],
  scope: string,
) {
  const next = useMemo(() => rosterRecords(rows, scope), [rows, scope]);
  const stable = useRef(next);
  const unchanged =
    stable.current.length === next.length &&
    next.every((row, index) => {
      const previous = stable.current[index];
      return (
        previous?.id === row.id &&
        previous.time === row.time &&
        previous.name === row.name &&
        previous.username === row.username &&
        previous.color === row.color &&
        previous.amount === row.amount
      );
    });
  if (!unchanged) stable.current = next;
  return stable.current;
}

export type PublicRosterProps = {
  open: boolean;
  onClose: () => void;
  activityId: string;
  activityTitle: string;
  author: { name: string; username: string; color?: string };
  type: Activity["type"];
  registrations?: readonly Readonly<RecipientExample>[];
  recipients: readonly Readonly<RecipientExample>[];
  drawProgress?: DrawProgress | null;
  showRecipients: boolean;
  fuzzy: boolean;
  identity: Identity;
  onOwnProfile: () => void;
  resetKey?: string;
  listState?: ListState;
  authorView?: boolean;
};

function useCursorRoster(
  records: readonly RosterRecord[],
  injectedState: ListState,
) {
  const [batch, setBatch] = useState<RosterBatch>(() =>
    injectedState === "ready"
      ? readRosterBatch(records)
      : { rows: [], nextCursor: null, hasMore: records.length > 0 },
  );
  const [status, setStatus] = useState(injectedState);
  const pending = useRef<ReturnType<typeof setTimeout> | null>(null);
  const recovered = useRef(false);
  const previous = useRef({ records, injectedState });

  const cancelPending = useCallback(() => {
    if (pending.current !== null) clearTimeout(pending.current);
    pending.current = null;
  }, []);

  useLayoutEffect(() => {
    const changedRecords = previous.current.records !== records;
    const changedState = previous.current.injectedState !== injectedState;
    if (!changedRecords && !changedState) return;
    previous.current = { records, injectedState };
    cancelPending();
    recovered.current = false;
    setStatus(injectedState);
    if (changedRecords)
      setBatch(
        injectedState === "ready"
          ? readRosterBatch(records)
          : { rows: [], nextCursor: null, hasMore: records.length > 0 },
      );
    else if (injectedState === "ready")
      setBatch((current) =>
        current.rows.length ? current : readRosterBatch(records),
      );
  }, [records, injectedState, cancelPending]);

  useEffect(() => cancelPending, [cancelPending]);

  const loadMore = useCallback(
    (retry = false) => {
      if (pending.current !== null || (status === "loading" && !retry)) return;
      if (!batch.hasMore && status !== "error") return;
      if (retry) recovered.current = true;
      setStatus("loading");
      pending.current = setTimeout(() => {
        pending.current = null;
        if (injectedState === "error" && !recovered.current) {
          setStatus("error");
          return;
        }
        const next = readRosterBatch(records, batch.nextCursor);
        setBatch((current) => ({
          ...next,
          rows: appendRosterRows(current.rows, next.rows),
        }));
        setStatus("ready");
      }, 180);
    },
    [records, batch, injectedState, status],
  );

  return { ...batch, status, loadMore };
}

function RosterRows({
  records,
  fullRecipients,
  type,
  registrationTab,
  pendingResult,
  emptyText,
  identity,
  onOwnProfile,
  listState,
  authorView,
}: {
  records: readonly RosterRecord[];
  fullRecipients: readonly RosterRecord[];
  type: Activity["type"];
  registrationTab: boolean;
  pendingResult: boolean;
  emptyText: string;
  identity: Identity;
  onOwnProfile: () => void;
  listState: ListState;
  authorView: boolean;
}) {
  const scroll = useRef<HTMLElement>(null);
  const end = useRef<HTMLDivElement>(null);
  const list = useCursorRoster(records, pendingResult ? "ready" : listState);
  const titles = !registrationTab ? recipientTitles(fullRecipients) : {};

  useEffect(() => {
    if (list.status !== "ready" || !list.hasMore) return;
    const root = scroll.current;
    const target = end.current;
    if (!root || !target) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) list.loadMore();
      },
      { root, rootMargin: "0px 0px 64px 0px" },
    );
    observer.observe(target);
    return () => observer.disconnect();
  }, [list.status, list.hasMore, list.loadMore]);

  return (
    <section
      ref={scroll}
      className="recipient-list"
      aria-label={
        registrationTab ? "报名记录" : type === "draw" ? "中奖记录" : "领取记录"
      }
      role={type === "draw" ? "tabpanel" : "region"}
      aria-busy={list.status === "loading" || pendingResult}
      tabIndex={0}
    >
      {list.rows.map((record) => (
        <div
          key={record.id}
          className={`recipient${registrationTab ? " recipient--registration" : ""}`}
          data-record-id={record.id}
          data-title={titles[record.username] ?? undefined}
          data-username={record.username}
        >
          {identity !== "guest" && record.username === "linjian" ? (
            <button
              className="user-identity"
              type="button"
              onClick={onOwnProfile}
            >
              <Avatar name={record.name} color={record.color} />
              <span>{record.name}</span>
            </button>
          ) : (
            <UserIdentity
              name={record.name}
              username={record.username}
              color={record.color}
            />
          )}
          {!registrationTab && record.amount && (
            <div className="recipient-award">
              {titles[record.username] && (
                <span
                  className={`recipient-title title-${titles[record.username]}`}
                >
                  {titles[record.username] === "highest" ? "手气王" : "手气亡"}
                </span>
              )}
              <strong className="recipient-award-amount">
                {record.amount} <small>LDC</small>
              </strong>
            </div>
          )}
          {authorView && (
            <details className="recipient-author-detail">
              <summary>作者明细</summary>
              {registrationTab ? (
                <p>报名已记录；开奖后与中奖记录关联。</p>
              ) : (
                <p>
                  LDC 金额 {record.amount ?? "待分配"}；付款状态：
                  {record.amount ? "已确认" : "待确认"}。
                </p>
              )}
            </details>
          )}
          <div className="recipient-time">
            <ShortTime
              value={record.time}
              full
              className="recipient-time__absolute"
            />
            <RelativeTime
              value={record.time}
              className="recipient-time__relative"
            />
          </div>
        </div>
      ))}
      <div ref={end} className="public-roster__load-state">
        {list.status === "loading" ? (
          <p role="status">加载中…</p>
        ) : list.status === "error" ? (
          <>
            <p role="alert">名单加载失败</p>
            <button
              className="text-button"
              type="button"
              onClick={() => list.loadMore(true)}
            >
              重试
            </button>
          </>
        ) : list.rows.length === 0 ? (
          <p role="status">{emptyText}</p>
        ) : list.hasMore ? (
          <button
            className="text-button"
            type="button"
            onClick={() => list.loadMore()}
          >
            加载更多
          </button>
        ) : (
          <p role="status">已显示全部</p>
        )}
      </div>
    </section>
  );
}

function RosterDialog({
  onClose,
  activityId,
  activityTitle,
  author: _author,
  type,
  registrations = noRecords,
  recipients,
  drawProgress = null,
  fuzzy,
  identity,
  onOwnProfile,
  resetKey = "",
  listState = "ready",
  authorView = false,
}: Omit<PublicRosterProps, "open" | "showRecipients">) {
  const [dialog, setDialog] = useState<HTMLDialogElement | null>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const backdropPress = useRef(false);
  const draw = type === "draw";
  const published = drawProgress === "completed" || drawProgress === "empty";
  const initialTab: RosterTab = published ? "winners" : "registrations";
  const [selection, setSelection] = useState({ published, tab: initialTab });
  const changedPublication = selection.published !== published;
  const tab = changedPublication ? initialTab : selection.tab;
  if (changedPublication) setSelection({ published, tab });
  const registrationTab = draw && tab === "registrations";
  const fullRecipients = useRosterRecords(
    recipients,
    `${activityId}:recipients`,
  );
  const fullRegistrations = useRosterRecords(
    registrations,
    `${activityId}:registrations`,
  );
  const pendingResult = draw && !registrationTab && !published;
  const records = registrationTab
    ? fullRegistrations
    : pendingResult
      ? noRosterRecords
      : fullRecipients;
  const headingId = useId();
  const titleId = useId();
  const heading = draw
    ? registrationTab
      ? "报名名单"
      : "中奖名单"
    : "领取名单";
  const count = registrationTab
    ? `${fullRegistrations.length} 人报名`
    : draw
      ? published
        ? `${fullRecipients.length} 人中奖`
        : null
      : `${fullRecipients.length} 人`;
  const registrationCount =
    fuzzy && !authorView ? null : `${fullRegistrations.length} 人报名`;
  const winnerCount =
    fuzzy && !authorView
      ? null
      : draw
        ? published
          ? `${fullRecipients.length} 人中奖`
          : drawProgress === "settling"
            ? "正在开奖"
            : "中奖结果待公布"
        : `${fullRecipients.length} 人`;
  const emptyText = pendingResult
    ? drawProgress === "settling"
      ? "正在开奖"
      : "等待开奖"
    : registrationTab
      ? "无人报名"
      : draw
        ? "无人中奖"
        : "暂无领取记录";

  useLayoutEffect(() => {
    if (!dialog) return;
    const opener = document.activeElement;
    dialog.showModal();
    closeButton.current?.focus({ preventScroll: true });
    return () => {
      dialog.close();
      if (
        opener instanceof HTMLElement &&
        opener.isConnected &&
        !document.querySelector("dialog[open]")
      )
        opener.focus({ preventScroll: true });
    };
  }, [dialog]);

  function isBackdropPress(event: PointerEvent<HTMLDialogElement>) {
    if (event.target !== event.currentTarget) return false;
    const rect = event.currentTarget.getBoundingClientRect();
    return (
      event.clientX < rect.left ||
      event.clientX > rect.right ||
      event.clientY < rect.top ||
      event.clientY > rect.bottom
    );
  }

  return (
    <dialog
      ref={setDialog}
      className="public-roster-dialog"
      aria-labelledby={headingId}
      aria-describedby={titleId}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onPointerDown={(event) => {
        backdropPress.current = isBackdropPress(event);
      }}
      onPointerUp={(event) => {
        if (backdropPress.current && isBackdropPress(event)) onClose();
        backdropPress.current = false;
      }}
    >
      <PortalTargetProvider target={dialog}>
        <section
          className="public-roster"
          data-roster-kind={draw ? tab : "recipients"}
          data-results-published={published}
        >
          <header className="public-roster__header">
            <div className="public-roster__topline">
              <h2 id={titleId} className="public-roster__activity-title">
                {activityTitle}
              </h2>
              <span id={headingId} className="public-roster__sr-title">
                {heading}
              </span>
              <CompactIconButton
                ref={closeButton}
                aria-label="关闭名单"
                onClick={onClose}
              >
                <X size={16} aria-hidden="true" />
              </CompactIconButton>
            </div>
            <div className="public-roster__summary">
              {draw ? (
                <>
                  {registrationCount && <span>{registrationCount}</span>}
                  {winnerCount && <span>{winnerCount}</span>}
                </>
              ) : (
                <>
                  <span>领取名单</span>
                  {authorView && <span>作者明细</span>}
                  {(!fuzzy || authorView) && count && <span>{count}</span>}
                </>
              )}
            </div>
            {draw && (
              <SegmentedControl<RosterTab>
                className="public-roster__tabs"
                label={authorView ? "作者名单" : "公开名单"}
                mode="tabs"
                value={tab}
                onChange={(next) => setSelection({ published, tab: next })}
                options={[
                  { value: "registrations", label: "报名名单" },
                  { value: "winners", label: "中奖名单" },
                ]}
              />
            )}
          </header>
          <RosterRows
            key={`${activityId}:${tab}:${resetKey}`}
            records={records}
            fullRecipients={fullRecipients}
            type={type}
            registrationTab={registrationTab}
            pendingResult={pendingResult}
            emptyText={emptyText}
            identity={identity}
            onOwnProfile={onOwnProfile}
            listState={listState}
            authorView={authorView}
          />
        </section>
      </PortalTargetProvider>
    </dialog>
  );
}

export function PublicRoster(props: PublicRosterProps) {
  if (!props.open || (!props.showRecipients && !props.authorView)) return null;
  return createPortal(
    <RosterDialog
      key={`${props.activityId}:${props.identity}:${props.resetKey ?? ""}`}
      {...props}
    />,
    document.body,
  );
}
