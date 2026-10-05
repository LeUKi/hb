import { createFileRoute, Link } from "@tanstack/react-router";
import { ActivityErrorView } from "../components/activities/activity-error";
import { ActivityLocator } from "../components/activities/activity-locator";
import { ExchangeScope } from "../components/activities/exchange-scope";
import { GlobalExchange } from "../components/activities/global-exchange";
import { Button } from "../components/ui/button";
import {
  getAuthErrorMessage,
  getLoginHref,
  isAuthUnavailable,
  useSession,
} from "../lib/auth";

export const Route = createFileRoute("/")({
  component: IndexPage,
});

function IndexPage() {
  const session = useSession();
  const authErrorCode = new URLSearchParams(window.location.search).get(
    "authError",
  );
  const authError = getAuthErrorMessage(authErrorCode);
  const loginUnavailable = isAuthUnavailable(authErrorCode);
  const user = session.error ? null : (session.data?.user ?? null);

  return (
    <>
      <ExchangeScope>
        <Link to="/square" className="underline underline-offset-4">
          浏览活动广场
        </Link>
      </ExchangeScope>
      <section>
        {authError ? (
          <p className="mt-4 rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
            {authError}
          </p>
        ) : null}
        {session.isPending ? (
          <p role="status">正在确认身份…</p>
        ) : session.isError ? (
          <ActivityErrorView
            error={session.error}
            retry={() => session.refetch()}
          />
        ) : user && session.data?.csrfToken ? (
          <GlobalExchange
            key={user.id}
            userId={user.id}
            csrfToken={session.data.csrfToken}
          />
        ) : (
          <div className="activity-panel space-y-4">
            <h1 className="text-2xl font-semibold">口令兑奖</h1>
            <p className="text-sm text-neutral-600">
              登录 Linux DO 账号后可提交口令兑换奖励。
            </p>
            {loginUnavailable ? (
              <p className="text-sm text-neutral-500">登录暂不可用</p>
            ) : (
              <Button asChild>
                <a href={getLoginHref("/")}>登录 Linux DO 账号</a>
              </Button>
            )}
          </div>
        )}
      </section>
      <ActivityLocator />
    </>
  );
}
