import { createFileRoute } from "@tanstack/react-router";
import { RefreshCw } from "lucide-react";
import { Button } from "../components/ui/button";
import {
  getAuthErrorMessage,
  getLoginHref,
  isAuthUnavailable,
  useSession,
} from "../lib/auth";

export const Route = createFileRoute("/account")({
  component: AccountPage,
});

function AccountPage() {
  const session = useSession();
  const authErrorCode = new URLSearchParams(window.location.search).get(
    "authError",
  );
  const authError = getAuthErrorMessage(authErrorCode);
  const loginUnavailable = isAuthUnavailable(authErrorCode);
  const user = session.error ? null : (session.data?.user ?? null);

  return (
    <section className="w-full max-w-3xl rounded-md border border-neutral-200 bg-white p-5 shadow-sm">
      <p className="text-sm font-medium text-neutral-500">账号</p>
      <h1 className="mt-2 text-3xl font-semibold tracking-normal text-neutral-950">
        登录状态
      </h1>
      {authError ? (
        <p className="mt-4 rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          {authError}
        </p>
      ) : null}

      {session.isPending ? (
        <p className="mt-5 text-sm leading-6 text-neutral-600" role="status">
          正在确认当前浏览器会话。
        </p>
      ) : session.error ? (
        <div className="mt-5 flex flex-col items-start gap-3">
          <p className="text-sm leading-6 text-red-700">
            {session.error.message}
          </p>
          <Button
            type="button"
            variant="secondary"
            onClick={() => session.refetch()}
          >
            <RefreshCw className="size-4" />
            重新检查
          </Button>
        </div>
      ) : user ? (
        <dl className="mt-5 grid gap-4 text-sm sm:grid-cols-3">
          <div>
            <dt className="text-neutral-500">显示名称</dt>
            <dd className="mt-1 font-medium text-neutral-950">
              {user.displayName}
            </dd>
          </div>
          <div>
            <dt className="text-neutral-500">用户名</dt>
            <dd className="mt-1 font-medium text-neutral-950">
              @{user.username}
            </dd>
          </div>
          <div>
            <dt className="text-neutral-500">账号 ID</dt>
            <dd className="mt-1 break-all font-medium text-neutral-950">
              {user.id}
            </dd>
          </div>
        </dl>
      ) : (
        <div className="mt-5 flex flex-col items-start gap-4">
          <p className="text-sm leading-6 text-neutral-600">
            请先使用 Linux DO 账号登录。登录后，这里会显示当前账号信息。
          </p>
          {loginUnavailable ? null : (
            <Button asChild>
              <a href={getLoginHref("/account")}>登录 Linux DO 账号</a>
            </Button>
          )}
        </div>
      )}
    </section>
  );
}
