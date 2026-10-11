import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { ActivityRequestError } from "../../lib/activities";
import { sessionQueryKey } from "../../lib/auth";
import { LoginOptions } from "../auth/login-options";
import { OfficialConnectRequired } from "../auth/official-connect-required";
import { Button } from "../ui/button";

export function ActivityErrorView({
  error,
  retry,
  notFoundMessage = "未找到活动，或你无权查看此活动。",
}: {
  error: Error;
  retry: () => unknown;
  notFoundMessage?: string;
}) {
  const queryClient = useQueryClient();
  const unauthorized =
    error instanceof ActivityRequestError && error.status === 401;
  const notFound =
    error instanceof ActivityRequestError && error.status === 404;
  const officialRequired =
    error instanceof ActivityRequestError &&
    error.code === "OFFICIAL_CONNECT_REQUIRED";
  useEffect(() => {
    if (unauthorized) {
      queryClient.setQueryData(sessionQueryKey, {
        user: null,
        csrfToken: null,
      });
      queryClient.removeQueries({ queryKey: ["activity-private"] });
      queryClient.removeQueries({ queryKey: ["claim-private"] });
      queryClient.removeQueries({ queryKey: ["redemption-private"] });
      queryClient.removeQueries({ queryKey: ["merchant-private"] });
    }
  }, [queryClient, unauthorized]);
  return (
    <section className="activity-panel space-y-4">
      <p role="alert">
        {unauthorized
          ? "登录已失效，请重新登录。"
          : notFound
            ? notFoundMessage
            : error.message}
      </p>
      {unauthorized ? (
        <LoginOptions returnTo={window.location.pathname} />
      ) : officialRequired ? (
        <OfficialConnectRequired />
      ) : notFound ? null : (
        <Button type="button" variant="secondary" onClick={() => retry()}>
          重试
        </Button>
      )}
    </section>
  );
}
