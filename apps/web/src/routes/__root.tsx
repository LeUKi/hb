import { useQueryClient } from "@tanstack/react-query";
import { createRootRoute, Link, Outlet } from "@tanstack/react-router";
import { useAtom } from "jotai";
import {
  Activity,
  Compass,
  Gift,
  Home,
  List,
  LogIn,
  LogOut,
  Plus,
  User,
  WalletCards,
} from "lucide-react";
import { useEffect, useRef } from "react";
import { Button } from "../components/ui/button";
import {
  getLoginHref,
  isAuthUnavailable,
  useLogout,
  useSession,
} from "../lib/auth";
import { exchangeContextAtom } from "../lib/discovery";

export const Route = createRootRoute({
  component: RootLayout,
});

function RootLayout() {
  const session = useSession();
  const queryClient = useQueryClient();
  const [exchangeContext, setExchangeContext] = useAtom(exchangeContextAtom);
  const authError = new URLSearchParams(window.location.search).get(
    "authError",
  );
  const loginUnavailable = isAuthUnavailable(authError);
  const logout = useLogout(session.data?.csrfToken);
  const returnTo = `${window.location.pathname}${window.location.search}${window.location.hash}`;
  const user = session.error ? null : (session.data?.user ?? null);
  const previousUserId = useRef<string | null>(null);
  useEffect(() => {
    const previous = previousUserId.current;
    if (!session.isPending) previousUserId.current = user?.id ?? null;
    if (!session.isPending && previous && previous !== user?.id) {
      const prefixes = [
        "activity-private",
        "claim-private",
        "redemption-private",
        "merchant-private",
        "password-private",
      ];
      const belongsToPrevious = (key: readonly unknown[]) =>
        prefixes.includes(String(key[0])) && key[1] === previous;
      void queryClient
        .cancelQueries({
          predicate: (query) => belongsToPrevious(query.queryKey),
        })
        .then(() =>
          queryClient.removeQueries({
            predicate: (query) => belongsToPrevious(query.queryKey),
          }),
        );
    }
    if (
      !session.isPending &&
      exchangeContext &&
      exchangeContext.userId !== user?.id
    )
      setExchangeContext(null);
    if (!session.isPending && !user) {
      void queryClient
        .cancelQueries({ queryKey: ["activity-private"] })
        .then(() => {
          queryClient.removeQueries({ queryKey: ["activity-private"] });
        });
      void queryClient
        .cancelQueries({ queryKey: ["claim-private"] })
        .then(() => {
          queryClient.removeQueries({ queryKey: ["claim-private"] });
        });
      void queryClient
        .cancelQueries({ queryKey: ["redemption-private"] })
        .then(() => {
          queryClient.removeQueries({ queryKey: ["redemption-private"] });
        });
      void queryClient
        .cancelQueries({ queryKey: ["merchant-private"] })
        .then(() => {
          queryClient.removeQueries({ queryKey: ["merchant-private"] });
        });
      const authenticatedPasswords = (key: readonly unknown[]) =>
        key[0] === "password-private" && key[1] !== "guest";
      void queryClient
        .cancelQueries({
          predicate: (query) => authenticatedPasswords(query.queryKey),
        })
        .then(() =>
          queryClient.removeQueries({
            predicate: (query) => authenticatedPasswords(query.queryKey),
          }),
        );
    }
  }, [
    queryClient,
    session.isPending,
    user,
    exchangeContext,
    setExchangeContext,
  ]);

  return (
    <div className="min-h-dvh bg-neutral-50 text-neutral-950">
      <header className="border-b border-neutral-200 bg-white">
        <nav className="mx-auto flex max-w-5xl flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex flex-wrap items-center gap-2">
            <Link
              to="/"
              className="inline-flex h-10 items-center gap-2 rounded-md px-3 text-sm font-medium text-neutral-700 hover:bg-neutral-100 [&.active]:bg-neutral-950 [&.active]:text-white"
            >
              <Home className="size-4" />
              首页
            </Link>
            <Link
              to="/status"
              className="inline-flex h-10 items-center gap-2 rounded-md px-3 text-sm font-medium text-neutral-700 hover:bg-neutral-100 [&.active]:bg-neutral-950 [&.active]:text-white"
            >
              <Activity className="size-4" />
              运行状态
            </Link>
            <Link
              to="/square"
              className="inline-flex h-10 items-center gap-2 rounded-md px-3 text-sm font-medium text-neutral-700 hover:bg-neutral-100 [&.active]:bg-neutral-950 [&.active]:text-white"
            >
              <Compass className="size-4" />
              活动广场
            </Link>
            <Link
              to="/my/activities"
              className="inline-flex h-10 items-center gap-2 rounded-md px-3 text-sm font-medium text-neutral-700 hover:bg-neutral-100 [&.active]:bg-neutral-950 [&.active]:text-white"
            >
              <List className="size-4" />
              我的活动
            </Link>
            <Link
              to="/activities/new"
              className="inline-flex h-10 items-center gap-2 rounded-md px-3 text-sm font-medium text-neutral-700 hover:bg-neutral-100 [&.active]:bg-neutral-950 [&.active]:text-white"
            >
              <Plus className="size-4" />
              创建活动
            </Link>
            <Link
              to="/my/claims"
              className="inline-flex h-10 items-center gap-2 rounded-md px-3 text-sm font-medium text-neutral-700 hover:bg-neutral-100 [&.active]:bg-neutral-950 [&.active]:text-white"
            >
              <Gift className="size-4" />
              我的领取
            </Link>
            <Link
              to="/my/merchants"
              className="inline-flex h-10 items-center gap-2 rounded-md px-3 text-sm font-medium text-neutral-700 hover:bg-neutral-100 [&.active]:bg-neutral-950 [&.active]:text-white"
            >
              <WalletCards className="size-4" />
              商户配置
            </Link>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {session.isPending ? (
              <span className="text-sm text-neutral-500">正在确认身份</span>
            ) : session.error ? (
              <>
                <span className="text-sm text-red-700">身份检查失败</span>
                <Button
                  type="button"
                  size="sm"
                  variant="secondary"
                  onClick={() => session.refetch()}
                >
                  重试
                </Button>
              </>
            ) : user ? (
              <>
                <Button asChild size="sm" variant="secondary">
                  <Link to="/account">
                    <User className="size-4" />
                    {user.displayName}
                  </Link>
                </Button>
                <Button
                  type="button"
                  size="sm"
                  onClick={() => logout.mutate()}
                  disabled={logout.isPending}
                >
                  <LogOut className="size-4" />
                  退出
                </Button>
                {logout.isError ? (
                  <span className="text-sm text-red-700">退出失败，请重试</span>
                ) : null}
              </>
            ) : loginUnavailable ? (
              <span className="text-sm text-neutral-500">登录暂不可用</span>
            ) : (
              <Button asChild size="sm">
                <a href={getLoginHref(returnTo)}>
                  <LogIn className="size-4" />
                  登录
                </a>
              </Button>
            )}
          </div>
        </nav>
      </header>
      <main className="mx-auto flex max-w-5xl flex-col gap-6 px-4 py-8">
        <Outlet />
      </main>
    </div>
  );
}
