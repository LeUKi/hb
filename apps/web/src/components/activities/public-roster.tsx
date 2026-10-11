import type {
  AuthorClaim,
  AuthorRegistration,
  PublicActivity,
  PublicRecipient,
  PublicRegistration,
  RegistrationStatus,
} from "@hb/contracts";
import { paymentLabel } from "@hb/contracts";
import { X } from "lucide-react";
import {
  type Dispatch,
  type SetStateAction,
  useLayoutEffect,
  useRef,
} from "react";
import { createPortal } from "react-dom";
import { RelativeTime, ShortTime } from "../../lib/clock";
import { useListRefreshAnchor } from "../../lib/list-refresh-anchor";
import { useRestoredScroll } from "../../lib/navigation-state";
import type {
  PublicRosterQuery,
  PublicRosterTab,
} from "../../lib/public-roster";
import { isBlockingQueryError } from "../../lib/query-view";
import { CompactIconButton } from "../presentation/compact-icon-button";
import {
  ListRefreshButton,
  SegmentedControl,
} from "../presentation/list-controls";
import { RefreshNotice, SkeletonRows } from "../presentation/loading";
import { PortalTargetProvider } from "../presentation/portal-target";
import { UserIdentity } from "../user-identity";

function rowTime(row: PublicRecipient | PublicRegistration) {
  if ("claimedAt" in row) return row.claimedAt;
  if ("registeredAt" in row) return row.registeredAt;
  return undefined;
}

type RosterRow =
  | PublicRecipient
  | PublicRegistration
  | AuthorClaim
  | AuthorRegistration;

function pageItems(
  page: NonNullable<PublicRosterQuery["data"]>["pages"][number],
): RosterRow[] {
  if ("enabled" in page && !page.enabled) return [];
  return page.items as RosterRow[];
}

function rowId(row: RosterRow) {
  return row.id;
}

function rowProfile(row: RosterRow) {
  if ("claimant" in row) return row.claimant;
  if ("participant" in row) return row.participant;
  return row;
}

function authorRowTime(row: AuthorClaim | AuthorRegistration) {
  return "claimedAt" in row ? row.claimedAt : row.registeredAt;
}

const registrationLabels: Record<RegistrationStatus, string> = {
  registered: "已报名",
  drawing: "开奖处理中",
  won: "已中奖",
  not_won: "未中奖",
};

function AuthorClaimDetail({ row }: { row: AuthorClaim }) {
  return row.rewardType === "text" ? (
    <details className="recipient-private">
      <summary>查看已分配文本</summary>
      <pre>{row.text}</pre>
    </details>
  ) : (
    <div className="recipient-private recipient-private--inline">
      <span>{row.amount} LDC</span>
      <span>{paymentLabel(row.payment.mode, row.payment.status)}</span>
      {row.payment.mode === "simulation" && <span>本地模拟</span>}
    </div>
  );
}

function AuthorRegistrationDetail({ row }: { row: AuthorRegistration }) {
  return (
    <div className="recipient-private recipient-private--inline">
      <span>{registrationLabels[row.status]}</span>
      {row.drawAt && (
        <span>
          开奖 <ShortTime value={row.drawAt} full />
        </span>
      )}
      {row.claim && (
        <span>
          奖励 {row.claim.rewardType === "ldc" ? "LDC" : "文本 / CDK"}
        </span>
      )}
    </div>
  );
}

export function PublicRoster({
  activity,
  query,
  tab,
  setTab,
  onClose,
  restoreFocus,
  restoreFocusLabel,
}: {
  activity: PublicActivity;
  query: PublicRosterQuery;
  tab: PublicRosterTab;
  setTab: Dispatch<SetStateAction<PublicRosterTab>>;
  onClose: () => void;
  restoreFocus?: Element | null;
  restoreFocusLabel?: string;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const opener = useRef<Element | null>(null);
  const backdrop = useRef(false);
  const complete =
    activity.draw?.state === "completed" || activity.draw?.state === "empty";
  const listRef = useRef<HTMLElement>(null);
  const entries: RosterRow[] = isBlockingQueryError(query)
    ? []
    : (query.data?.pages.flatMap((page) => pageItems(page)) ?? []);
  const rows = [
    ...new Map(entries.map((entry) => [rowId(entry), entry])).values(),
  ];
  const authorView = query.view === "author";
  useRestoredScroll(
    listRef,
    `roster:${query.scope}`,
    query.data !== undefined,
    tab,
  );
  useListRefreshAnchor(listRef, {
    fetching: query.isFetching,
    updatedAt: query.dataUpdatedAt,
    error: query.isError,
    scope: query.scope,
  });
  useLayoutEffect(() => {
    opener.current = restoreFocus ?? document.activeElement;
    dialog.current?.showModal();
    dialog.current
      ?.querySelector<HTMLButtonElement>("[data-roster-close]")
      ?.focus({ preventScroll: true });
    return () => dialog.current?.close();
  }, [restoreFocus]);
  function close(returnFocus = true) {
    dialog.current?.close();
    onClose();
    if (!returnFocus) return;
    requestAnimationFrame(() => {
      const fallback = restoreFocusLabel
        ? Array.from(
            document.querySelectorAll<HTMLButtonElement>(
              'button[aria-haspopup="dialog"]',
            ),
          ).find((button) => button.textContent?.trim() === restoreFocusLabel)
        : null;
      const target =
        opener.current instanceof HTMLElement && opener.current.isConnected
          ? opener.current
          : fallback;
      target?.focus({ preventScroll: true });
    });
  }
  function maybeFetchNext(node: HTMLElement) {
    if (
      node.scrollHeight - node.clientHeight - node.scrollTop < 100 &&
      query.hasNextPage &&
      !query.isFetching &&
      !query.isError
    )
      void query.fetchNextPage();
  }
  return createPortal(
    <dialog
      ref={dialog}
      className="public-roster-dialog"
      aria-label={activity.title || "活动名单"}
      onCancel={(event) => {
        event.preventDefault();
        close();
      }}
      onPointerDown={(event) => {
        backdrop.current = event.target === event.currentTarget;
      }}
      onPointerUp={(event) => {
        if (backdrop.current && event.target === event.currentTarget) close();
        backdrop.current = false;
      }}
      onKeyDownCapture={(event) => {
        if (event.key !== "Escape") return;
        if ((event.target as Element | null)?.closest(".identity-popover"))
          return;
        event.preventDefault();
        event.stopPropagation();
        close();
      }}
    >
      <PortalTargetProvider target={dialog.current}>
        <div className="public-roster">
          <header className="public-roster__header">
            <div className="public-roster__topline">
              <h2 className="public-roster__activity-title">
                {activity.title || "活动名单"}
              </h2>
              <ListRefreshButton
                busy={query.isFetching}
                label={
                  tab === "registrations"
                    ? "刷新报名名单"
                    : activity.draw
                      ? "刷新中奖名单"
                      : "刷新领取名单"
                }
                onRefresh={() => {
                  void query.refetch();
                }}
              />
              <CompactIconButton
                data-roster-close
                aria-label="关闭"
                onClick={() => close()}
              >
                <X size={16} aria-hidden="true" />
              </CompactIconButton>
            </div>
            <div className="public-roster__summary">
              <UserIdentity
                profile={activity.author}
                className="user-identity"
              />
              {activity.draw?.registeredCount !== null &&
                activity.draw?.registeredCount !== undefined && (
                  <span>报名 {activity.draw.registeredCount} 人</span>
                )}
              {activity.draw?.winnerCount !== null &&
                activity.draw?.winnerCount !== undefined &&
                complete && <span>中奖 {activity.draw.winnerCount} 人</span>}
            </div>
            {activity.draw && (
              <div className="public-roster__tabs">
                <SegmentedControl
                  label="名单类型"
                  mode="tabs"
                  value={tab}
                  onChange={setTab}
                  options={[
                    { value: "registrations", label: "报名名单" },
                    { value: "recipients", label: "中奖名单" },
                  ]}
                />
              </div>
            )}
          </header>
          <section
            ref={listRef}
            className="recipient-list"
            aria-label={
              tab === "registrations"
                ? "报名记录"
                : activity.draw
                  ? "中奖记录"
                  : "领取记录"
            }
            role={activity.draw ? "tabpanel" : "region"}
            tabIndex={0}
            aria-busy={query.isPending || query.isFetchingNextPage}
            onScroll={(event) => maybeFetchNext(event.currentTarget)}
          >
            {query.isPending ? (
              <div className="public-roster__load-state">
                <span role="status" className="sr-only">
                  正在读取名单…
                </span>
                <SkeletonRows />
              </div>
            ) : isBlockingQueryError(query) ? (
              <div className="public-roster__load-state" role="alert">
                <p>名单读取失败。</p>
                <button
                  className="text-button"
                  type="button"
                  onClick={() => {
                    void query.refetch();
                  }}
                >
                  重试
                </button>
              </div>
            ) : !authorView &&
              query.data?.pages[0] &&
              "enabled" in query.data.pages[0] &&
              query.data.pages[0].enabled === false ? (
              <div className="public-roster__load-state">
                <p>作者未公开名单。</p>
              </div>
            ) : (
              <>
                {!query.isFetchNextPageError && <RefreshNotice query={query} />}
                {rows.length ? (
                  rows.map((row) => (
                    <div
                      className="recipient"
                      key={rowId(row)}
                      data-record-id={rowId(row)}
                    >
                      <UserIdentity
                        profile={rowProfile(row)}
                        className="user-identity"
                      />
                      {"amount" in row && row.amount !== undefined && (
                        <div className="recipient-award">
                          {"title" in row && row.title && (
                            <span
                              className={`recipient-title title-${row.title === "highest" ? "highest" : "lowest"}`}
                            >
                              {row.title === "highest" ? "手气王" : "手气亡"}
                            </span>
                          )}
                          <strong className="recipient-award-amount">
                            {row.amount} <small>LDC</small>
                          </strong>
                        </div>
                      )}
                      {("claimedAt" in row || "registeredAt" in row) && (
                        <div className="recipient-time roster-time">
                          <ShortTime
                            value={
                              "claimant" in row || "participant" in row
                                ? authorRowTime(row)
                                : rowTime(row)
                            }
                            full
                            className="recipient-time__absolute"
                          />
                          <RelativeTime
                            value={
                              "claimant" in row || "participant" in row
                                ? authorRowTime(row)
                                : rowTime(row)
                            }
                            className="recipient-time__relative"
                          />
                        </div>
                      )}
                      {"claimant" in row && <AuthorClaimDetail row={row} />}
                      {"participant" in row && (
                        <AuthorRegistrationDetail row={row} />
                      )}
                    </div>
                  ))
                ) : (
                  <div className="public-roster__load-state">
                    <p>暂无{tab === "registrations" ? "报名" : "领取"}记录。</p>
                  </div>
                )}
                {query.isFetchNextPageError && (
                  <div className="public-roster__load-state" role="alert">
                    <p>后续记录读取失败，可重试加载。</p>
                  </div>
                )}
                {query.hasNextPage ? (
                  <div className="public-roster__load-state">
                    <button
                      className="text-button"
                      type="button"
                      disabled={query.isFetching}
                      onClick={() => {
                        void query.fetchNextPage();
                      }}
                    >
                      {query.isFetchingNextPage
                        ? "正在加载…"
                        : query.isFetchNextPageError
                          ? "重试加载"
                          : "加载更多"}
                    </button>
                  </div>
                ) : rows.length > 0 ? (
                  <div className="public-roster__load-state">
                    <p>已加载完毕</p>
                  </div>
                ) : null}
              </>
            )}
          </section>
        </div>
      </PortalTargetProvider>
    </dialog>,
    document.body,
  );
}
