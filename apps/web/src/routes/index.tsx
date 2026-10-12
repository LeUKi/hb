import { createFileRoute, useRouterState } from "@tanstack/react-router";
import { ArrowRight } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { AttemptHistory } from "../components/activities/attempt-history";
import {
  GlobalExchange,
  type GlobalExchangeHandle,
} from "../components/activities/global-exchange";
import {
  PublicActivitiesDialog,
  type SquareStatus,
} from "../components/activities/public-activities-dialog";
import { Envelope } from "../components/presentation/envelope";
import { activityToolsEnabled } from "../lib/activity-tools-release";
import { getAuthErrorMessage, useSession } from "../lib/auth";
import {
  useEntryNavigate,
  useHistoryOverlay,
  useViewState,
} from "../lib/navigation-state";
export const Route = createFileRoute("/")({ component: IndexPage });
function IndexPage() {
  const exchange = useRef<GlobalExchangeHandle>(null);
  const session = useSession();
  const publicActivities = useHistoryOverlay("public-activities");
  const publicActivitiesTrigger = useRef<HTMLButtonElement>(null);
  const [requestedOpen, setRequestedOpen] = useState(false);
  const [storedStatus, setStatus] = useViewState<SquareStatus>(
    "public-activities-status",
    "all",
  );
  const status =
    storedStatus === "active" || storedStatus === "ended"
      ? storedStatus
      : "all";
  const legacyStatus = useRouterState({
    select: (state) => state.location.state.hbOpenPublicActivities,
  });
  const navigate = useEntryNavigate();
  const publicActivitiesOpen = Boolean(publicActivities.overlay);
  useLayoutEffect(() => {
    if (publicActivitiesOpen) exchange.current?.openPublicActivities();
  }, [publicActivitiesOpen]);
  const consumingLegacy = useRef(false);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    if (session.isPending) return;
    if (legacyStatus && !consumingLegacy.current) {
      consumingLegacy.current = true;
      setStatus(legacyStatus);
      void navigate({
        to: "/",
        replace: true,
        resetScroll: false,
        search: {},
        state: { hbOpenPublicActivities: undefined },
      }).then(() => {
        if (mounted.current) publicActivities.open();
        consumingLegacy.current = false;
      });
    } else if (requestedOpen) {
      setRequestedOpen(false);
      publicActivities.open();
    }
  }, [
    session.isPending,
    legacyStatus,
    requestedOpen,
    navigate,
    setStatus,
    publicActivities.open,
  ]);
  const user = session.error ? null : session.data?.user;
  const authError = getAuthErrorMessage(
    new URLSearchParams(window.location.search).get("authError"),
  );
  return (
    <div className="home-page">
      <section className="home-hero" aria-label="口令兑奖">
        <Envelope size="small" open={false} />
        <div className="home-exchange">
          {authError && (
            <p role="alert" className="form-message">
              {authError}
            </p>
          )}
          <button
            ref={publicActivitiesTrigger}
            id="public-activities-trigger"
            type="button"
            className="public-activities-link"
            aria-haspopup="dialog"
            aria-expanded={Boolean(publicActivities.overlay)}
            onClick={() => {
              exchange.current?.openPublicActivities();
              if (session.isPending) setRequestedOpen(true);
              else publicActivities.open();
            }}
          >
            <span className="public-activities-label">已公开的活动</span>
            <ArrowRight size={14} aria-hidden="true" />
          </button>
          <GlobalExchange ref={exchange} />
        </div>
      </section>
      {publicActivities.overlay && (
        <PublicActivitiesDialog
          status={status}
          onStatusChange={setStatus}
          onClose={publicActivities.close}
          restoreFocus={publicActivitiesTrigger.current}
        />
      )}
      {activityToolsEnabled && user && !session.isError && (
        <AttemptHistory
          key={user.id}
          userId={user.id}
          onFill={(password) => exchange.current?.fillPassword(password)}
        />
      )}
    </div>
  );
}
