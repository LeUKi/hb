import { createFileRoute } from "@tanstack/react-router";
import { Copy, RefreshCw } from "lucide-react";
import { useState } from "react";
import { Button } from "../components/ui/button";
import { UserAvatar } from "../components/user-identity";
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
  const [copyMessage, setCopyMessage] = useState<string | null>(null);
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
        <div className="mt-5 space-y-5">
          <div className="flex flex-wrap items-center gap-4">
            <UserAvatar
              profile={{
                username: user.username,
                displayName: user.displayName,
                avatarUrl: user.avatarUrl,
              }}
              size="lg"
            />
            <div className="min-w-0">
              <p className="truncate text-xl font-semibold text-neutral-950">
                {user.displayName || user.username}
              </p>
              <p className="truncate text-sm text-neutral-500">
                @{user.username}
              </p>
            </div>
          </div>
          <dl className="grid gap-4 text-sm sm:grid-cols-3">
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
            <div className="sm:col-span-3">
              <dt className="text-neutral-500">Connect 邮箱</dt>
              <dd className="mt-1 flex min-w-0 flex-wrap items-center gap-3 font-medium text-neutral-950">
                {user.email ? (
                  <>
                    <span className="break-all">{user.email}</span>
                    <Button
                      type="button"
                      size="sm"
                      variant="secondary"
                      onClick={() => {
                        if (!navigator.clipboard) {
                          setCopyMessage("复制失败，请手动选择。");
                          return;
                        }
                        void navigator.clipboard
                          .writeText(user.email ?? "")
                          .then(() => setCopyMessage("邮箱已复制。"))
                          .catch(() =>
                            setCopyMessage("复制失败，请手动选择。"),
                          );
                      }}
                    >
                      <Copy className="size-4" />
                      复制
                    </Button>
                  </>
                ) : (
                  <span className="text-neutral-600">Connect 尚未提供邮箱</span>
                )}
              </dd>
            </div>
          </dl>
          {copyMessage ? (
            <p role="status" className="text-sm text-neutral-600">
              {copyMessage}
            </p>
          ) : null}
          <div className="space-y-3 rounded-md border border-neutral-200 bg-neutral-50 p-4 text-sm leading-6 text-neutral-600">
            <p>
              邮箱地址来自
              Connect，本站暂未接入邮件通知；后续接入邮件服务时会单独核实送达规则。
            </p>
            {loginUnavailable ? null : (
              <Button asChild variant="secondary">
                <a href={getLoginHref("/account")}>重新登录以更新资料</a>
              </Button>
            )}
          </div>
        </div>
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
