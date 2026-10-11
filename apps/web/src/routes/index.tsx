import { createFileRoute } from "@tanstack/react-router";
import { useRef } from "react";
import { AttemptHistory } from "../components/activities/attempt-history";
import {
  GlobalExchange,
  type GlobalExchangeHandle,
} from "../components/activities/global-exchange";
import { Envelope } from "../components/presentation/envelope";
import { activityToolsEnabled } from "../lib/activity-tools-release";
import { getAuthErrorMessage, useSession } from "../lib/auth";
export const Route = createFileRoute("/")({ component: IndexPage });
function IndexPage() {
  const exchange = useRef<GlobalExchangeHandle>(null);
  const session = useSession();
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
          <GlobalExchange ref={exchange} />
        </div>
      </section>
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
