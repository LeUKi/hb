import { useQueryClient } from "@tanstack/react-query";
import {
  createRootRoute,
  Link,
  Outlet,
  useRouter,
  useRouterState,
} from "@tanstack/react-router";
import { useAtom, useSetAtom } from "jotai";
import { Compass, Gift, Home, Plus, Settings2, UserRound } from "lucide-react";
import { LayoutGroup, motion, useReducedMotion } from "motion/react";
import { useEffect, useRef } from "react";
import { SessionActionsContext } from "../components/auth/session-actions";
import { RedemptionNavigation } from "../components/presentation/redemption-transition";
import { UserAvatar } from "../components/user-identity";
import { clearAttemptOperations } from "../lib/attempt-history";
import {
  sessionIdentity,
  sessionQueryKey,
  useLogout,
  useSession,
} from "../lib/auth";
import { exchangeContextAtom } from "../lib/discovery";
import {
  FreshLink,
  NavigationStateProvider,
  NavigationViewport,
} from "../lib/navigation-state";
import {
  redemptionIntentAtom,
  rewardAnimationAtom,
} from "../lib/redemption-intent";

export const Route = createRootRoute({
  component: RootLayout,
});

function RootLayout() {
  const session = useSession();
  const motionOff = useReducedMotion();
  const queryClient = useQueryClient();
  const [exchangeContext, setExchangeContext] = useAtom(exchangeContextAtom);
  const setRedemptionIntent = useSetAtom(redemptionIntentAtom);
  const setRewardAnimation = useSetAtom(rewardAnimationAtom);
  const logout = useLogout(session.data?.csrfToken);
  const user = session.error ? null : (session.data?.user ?? null);
  // The first identity result fills the loading shell; only a later account
  // change rebuilds the private subtree.
  const navigationIdentity = useRef<{ confirmed?: string; generation: number }>(
    { generation: 0 },
  );
  if (session.isSuccess) {
    const confirmed = user?.id ?? "guest";
    if (
      navigationIdentity.current.confirmed !== undefined &&
      navigationIdentity.current.confirmed !== confirmed
    )
      navigationIdentity.current.generation += 1;
    navigationIdentity.current.confirmed = confirmed;
  }
  const previousIdentity = useRef<string | null>(null);
  useEffect(() => {
    const previous = previousIdentity.current;
    const identity = sessionIdentity(user);
    if (!session.isPending) previousIdentity.current = identity;
    if (!session.isPending && previous && previous !== identity) {
      setExchangeContext(null);
      setRedemptionIntent(null);
      setRewardAnimation(null);
      const previousUserId = previous.split(":", 1)[0] ?? null;
      const currentUserId = identity?.split(":", 1)[0] ?? null;
      if (previousUserId) clearAttemptOperations(previousUserId);
      if (previousUserId !== currentUserId) {
        queryClient.getMutationCache().clear();
        const containsUserData = (key: readonly unknown[]) =>
          key[0] !== "api-health" && key[0] !== "auth";
        void queryClient
          .cancelQueries({
            predicate: (query) => containsUserData(query.queryKey),
          })
          .then(async () => {
            queryClient.removeQueries({
              predicate: (query) =>
                containsUserData(query.queryKey) &&
                query.getObserversCount() === 0,
            });
            await queryClient.resetQueries({
              predicate: (query) => containsUserData(query.queryKey),
            });
          });
      }
    }
    if (
      !session.isPending &&
      exchangeContext &&
      (exchangeContext.userId !== user?.id ||
        exchangeContext.accountTier !== user?.accountTier)
    )
      setExchangeContext(null);
    if (!session.isPending && !user) {
      setRedemptionIntent(null);
      setRewardAnimation(null);
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
    setRedemptionIntent,
    setRewardAnimation,
  ]);

  const pathname = useRouterState({
    select: (state) => state.location.pathname,
  });
  const returnTo = useRouterState({ select: (state) => state.location.href });
  const router = useRouter();
  const appliedResets = useRef(new Set<string>());
  useEffect(
    () =>
      router.subscribe("onBeforeNavigate", ({ fromLocation, toLocation }) => {
        const token = toLocation.state.hbReset;
        if (
          toLocation.pathname === "/account" &&
          (fromLocation?.pathname !== "/account" ||
            (token && !appliedResets.current.has(token)))
        ) {
          // Confirm login options on entry, reusing the root's in-flight read.
          void queryClient.invalidateQueries(
            { queryKey: sessionQueryKey },
            { cancelRefetch: false },
          );
        }
        if (!token || appliedResets.current.has(token)) return;
        appliedResets.current.add(token);
        if (toLocation.pathname === "/") {
          setExchangeContext(null);
          setRedemptionIntent(null);
        }
      }),
    [router, queryClient, setExchangeContext, setRedemptionIntent],
  );
  useEffect(() => {
    if (session.isPending || user?.isAdmin) return;
    void queryClient
      .cancelQueries({ queryKey: ["admin-private"] })
      .then(() => queryClient.removeQueries({ queryKey: ["admin-private"] }));
  }, [queryClient, session.isPending, user?.isAdmin]);

  const nav = [
    {
      to: "/" as const,
      label: "兑奖",
      icon: Home,
      active:
        pathname === "/" ||
        (pathname.startsWith("/activities/") && pathname !== "/activities/new"),
    },
    {
      to: "/square" as const,
      label: "活动广场",
      icon: Compass,
      active: pathname === "/square",
    },
    {
      to: "/my/activities" as const,
      label: "活动历史",
      icon: Gift,
      active:
        pathname.startsWith("/my/activities") ||
        pathname.startsWith("/my/claims"),
    },
    {
      to: "/account" as const,
      label: "我的",
      icon: UserRound,
      active:
        pathname === "/account" ||
        pathname.startsWith("/my/merchants") ||
        pathname === "/my/payments",
    },
    ...(user?.isAdmin
      ? [
          {
            to: "/admin/rate-limits" as const,
            label: "管理",
            icon: Settings2,
            active: pathname.startsWith("/admin/"),
          },
        ]
      : []),
  ];

  const guestLogin =
    pathname === "/account" && !session.isPending && !session.error && !user;
  return (
    <NavigationStateProvider
      identity={session.isPending ? "pending" : (user?.id ?? "guest")}
    >
      <div
        className={`tool-shell tool-shell--formal${guestLogin ? " tool-shell--guest-login" : ""}`}
      >
        <a className="skip-link" href="#main">
          跳到主要内容
        </a>
        {!guestLogin && (
          <header className="site-header">
            <div className="header-inner">
              <FreshLink className="wordmark" to="/" aria-label="解meme 首页">
                <span className="brand-seal" aria-hidden="true">
                  <Gift size={18} />
                </span>
                <span>解meme</span>
              </FreshLink>
              <LayoutGroup id="desktop-navigation">
                <nav className="desktop-nav" aria-label="主导航">
                  {nav.map(({ to, label, active }) => (
                    <FreshLink
                      key={to}
                      to={to}
                      aria-current={active ? "page" : undefined}
                    >
                      {label}
                      {active && (
                        <motion.span
                          className="nav-active-indicator"
                          layoutId={motionOff ? undefined : "active-underline"}
                          initial={false}
                          transition={{
                            duration: motionOff ? 0 : 0.2,
                            ease: "easeOut",
                          }}
                          aria-hidden="true"
                        />
                      )}
                    </FreshLink>
                  ))}
                </nav>
              </LayoutGroup>
              <div className="header-actions">
                <Link className="create-link" to="/activities/new">
                  <Plus size={17} aria-hidden="true" />
                  发起活动
                </Link>
                {session.isPending ? (
                  <span className="muted">正在确认身份</span>
                ) : session.error ? (
                  <button
                    className="button ghost"
                    type="button"
                    onClick={() => session.refetch()}
                  >
                    身份检查失败，重试
                  </button>
                ) : !user ? (
                  <Link
                    className="own-identity"
                    to="/account"
                    search={{ returnTo }}
                  >
                    登录
                  </Link>
                ) : (
                  <Link
                    className="own-identity"
                    to="/account"
                    aria-label="我的账号"
                  >
                    <UserAvatar profile={user} />
                    <span>{user.displayName || user.username}</span>
                    {user.accountTier === "lite" && (
                      <span className="lite-badge">青春版</span>
                    )}
                  </Link>
                )}
              </div>
            </div>
          </header>
        )}
        <motion.main layoutScroll id="main" className="site-main" tabIndex={-1}>
          {logout.isError && (
            <p className="form-message" role="alert">
              退出失败，请重试
            </p>
          )}
          <SessionActionsContext.Provider value={logout}>
            <RedemptionNavigation key={navigationIdentity.current.generation}>
              <NavigationViewport>
                <Outlet />
              </NavigationViewport>
            </RedemptionNavigation>
          </SessionActionsContext.Provider>
        </motion.main>
        {!guestLogin && (
          <LayoutGroup id="mobile-navigation">
            <nav
              className="mobile-nav"
              aria-label="手机导航"
              style={{
                gridTemplateColumns: `repeat(${nav.length}, minmax(0, 1fr))`,
              }}
            >
              {nav.map(({ to, label, icon: Icon, active }) => (
                <FreshLink
                  key={to}
                  to={to}
                  aria-current={active ? "page" : undefined}
                >
                  <Icon size={20} strokeWidth={1.7} aria-hidden="true" />
                  <span>{label}</span>
                  {active && (
                    <motion.span
                      className="nav-active-indicator"
                      layoutId={motionOff ? undefined : "active-underline"}
                      initial={false}
                      transition={{
                        duration: motionOff ? 0 : 0.2,
                        ease: "easeOut",
                      }}
                      aria-hidden="true"
                    />
                  )}
                </FreshLink>
              ))}
            </nav>
          </LayoutGroup>
        )}
      </div>
    </NavigationStateProvider>
  );
}
