import { createFileRoute, Link } from "@tanstack/react-router";
import {
  ArrowDownLeft,
  ArrowRight,
  CheckCircle2,
  ChevronRight,
  Copy,
  FileText,
  Gift,
  KeyRound,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { LoginOptions } from "../components/auth/login-options";
import { useAppLogout } from "../components/auth/session-actions";
import { Help } from "../components/presentation/context-help";
import {
  PageSkeleton,
  RefreshNotice,
} from "../components/presentation/loading";
import { UserAvatar } from "../components/user-identity";
import { useAccountProfile } from "../lib/account-profile";
import {
  getAuthErrorMessage,
  getLoginHref,
  getUpgradeHref,
  isAuthUnavailable,
  sessionIdentity,
  useSession,
} from "../lib/auth";
import { isBlockingQueryError } from "../lib/query-view";
import { Dialog, PageTitle } from "../prototype-ui/workbench-ui";
export const Route = createFileRoute("/account")({
  validateSearch: (search): { returnTo?: string; authError?: string } => ({
    returnTo: typeof search.returnTo === "string" ? search.returnTo : undefined,
    authError:
      typeof search.authError === "string" ? search.authError : undefined,
  }),
  component: AccountPage,
});
function AccountPage() {
  const { returnTo = "/account" } = Route.useSearch();
  const session = useSession();
  const logout = useAppLogout();
  const [upgrade, setUpgrade] = useState(false);
  const [emailCopyFeedback, setEmailCopyFeedback] = useState<
    "copied" | "failed" | null
  >(null);
  const authErrorCode = new URLSearchParams(window.location.search).get(
    "authError",
  );
  const authError = getAuthErrorMessage(authErrorCode);
  const user = session.error ? null : session.data?.user;
  const liteauthEnabled = session.data?.loginOptions?.liteauthEnabled === true;
  const profile = useAccountProfile(user ?? null);
  const identity = sessionIdentity(user ?? null);
  const activeIdentity = useRef(identity);
  activeIdentity.current = identity;
  useEffect(() => {
    if (identity !== null) setEmailCopyFeedback(null);
  }, [identity]);
  if (session.isPending) return <PageSkeleton title="账号" />;
  if (session.isError)
    return (
      <div className="work-page">
        <p className="work-form-error" role="alert">
          {session.error.message}
        </p>
        <button
          className="button secondary"
          type="button"
          onClick={() => session.refetch()}
        >
          重新检查
        </button>
      </div>
    );
  if (!user)
    return (
      <div className="work-page work-guest-prompt work-login-page">
        <LoginOptions returnTo={returnTo} notice={authError} />
      </div>
    );
  const lite = user.accountTier === "lite";
  const profileError = isBlockingQueryError(profile);
  const connectEmail = profileError ? undefined : profile.data?.user?.email;

  return (
    <div className="work-page work-account-page">
      <PageTitle title="账号信息" />
      <div className="work-account-hero">
        <div className="work-account-avatar">
          <UserAvatar profile={user} size="lg" />
        </div>
        <div className="work-account-name">
          <h2>{user.displayName || user.username}</h2>
          <p>
            @{user.username}{" "}
            <span className={`work-identity-label ${lite ? "is-lite" : ""}`}>
              {lite ? "青春版" : "普通账号"}
            </span>
          </p>
        </div>
        {(user.loginProvider !== "liteauth" || liteauthEnabled) && (
          <button
            className="button secondary"
            type="button"
            disabled={isAuthUnavailable(authErrorCode, user.loginProvider)}
            onClick={() =>
              window.location.assign(
                getLoginHref("/account", user.loginProvider),
              )
            }
          >
            刷新资料
          </button>
        )}
      </div>
      {authError && (
        <p className="work-form-error" role="alert">
          {authError}
        </p>
      )}
      <div className="work-account-layout">
        <section
          className="work-account-details"
          aria-labelledby="work-account-info"
        >
          <h2 id="work-account-info">账号资料</h2>
          <dl className="work-account-rows">
            <div>
              <dt>昵称</dt>
              <dd>{user.displayName || user.username}</dd>
            </div>
            <div>
              <dt>论坛用户名</dt>
              <dd>@{user.username}</dd>
            </div>
            <div>
              <dt>本账号 ID</dt>
              <dd>{user.id}</dd>
            </div>
            <div>
              <dt>本次登录来源</dt>
              <dd>
                {user.loginProvider === "liteauth"
                  ? "LiteAuth 青春版"
                  : "官方 Connect"}
              </dd>
            </div>
            <div>
              <dt className="work-account-field-heading">
                Connect 邮箱
                <Help label="Connect 邮箱">
                  邮箱由认证服务提供，本站不可编辑，暂未接入邮件通知。
                </Help>
              </dt>
              <dd
                aria-busy={profile.isPending}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  minWidth: 0,
                }}
              >
                {profile.isPending ? (
                  <span role="status">正在读取邮箱…</span>
                ) : profileError ? (
                  <span className="work-form-error" role="alert">
                    邮箱读取失败。
                    <button
                      className="work-text-link"
                      type="button"
                      onClick={() => void profile.refetch()}
                    >
                      重试
                    </button>
                  </span>
                ) : !connectEmail ? (
                  user.loginProvider === "liteauth" ? (
                    "LiteAuth 尚未提供邮箱"
                  ) : (
                    "Connect 尚未提供邮箱"
                  )
                ) : (
                  <>
                    <span style={{ minWidth: 0, overflowWrap: "anywhere" }}>
                      {connectEmail}
                    </span>
                    <button
                      className="button ghost"
                      type="button"
                      aria-label="复制 Connect 邮箱"
                      style={{
                        width: 44,
                        minWidth: 44,
                        height: 44,
                        minHeight: 44,
                        padding: 0,
                        flexShrink: 0,
                      }}
                      onClick={async () => {
                        try {
                          await navigator.clipboard.writeText(connectEmail);
                          if (activeIdentity.current === identity)
                            setEmailCopyFeedback("copied");
                        } catch {
                          if (activeIdentity.current === identity)
                            setEmailCopyFeedback("failed");
                        }
                      }}
                    >
                      <Copy size={16} aria-hidden="true" />
                    </button>
                  </>
                )}
              </dd>
            </div>
            <div>
              <dt className="work-account-field-heading">
                账号资格
                <Help label="账号资格">
                  {lite
                    ? "青春版可登录浏览活动。通过官方 Connect 登录可获得创建、兑奖和报名资格。"
                    : "普通资格可创建、兑奖和报名 LDC 活动；后续使用 LiteAuth 登录不会降级。"}
                </Help>
              </dt>
              <dd>
                <span className={`work-qualification ${lite ? "is-lite" : ""}`}>
                  {lite ? "青春版账号" : "普通账号"}
                </span>
              </dd>
            </div>
          </dl>
          <RefreshNotice query={profile} />
          {!lite && emailCopyFeedback && (
            <p
              className={
                emailCopyFeedback === "copied"
                  ? "work-inline-success"
                  : "work-form-error"
              }
              style={
                emailCopyFeedback === "copied"
                  ? { margin: "12px 0 0" }
                  : undefined
              }
              role="status"
            >
              {emailCopyFeedback === "copied" && (
                <CheckCircle2 size={16} aria-hidden="true" />
              )}
              {emailCopyFeedback === "copied"
                ? "Connect 邮箱已复制。"
                : "复制失败，请手动选择并复制上方邮箱。"}
            </p>
          )}
          <div className="work-account-permissions">
            {lite && (
              <p className="work-setting-notice">
                LDC 奖励需官方 Connect 资格。
              </p>
            )}
            {lite && (
              <button
                className="work-text-link"
                type="button"
                onClick={() => setUpgrade(true)}
              >
                通过官方 Connect 升级 <ArrowRight size={15} />
              </button>
            )}
          </div>
        </section>
        <aside className="work-account-nav">
          <h2>账号管理</h2>
          <Link to="/my/claims">
            <span>
              <Gift size={19} /> 我的参与
            </span>
            <ChevronRight size={18} />
          </Link>
          <Link to="/my/activities">
            <span>
              <FileText size={19} /> 我的活动
            </span>
            <ChevronRight size={18} />
          </Link>
          <Link to="/my/merchants">
            <span>
              <KeyRound size={19} /> 商户配置
            </span>
            <ChevronRight size={18} />
          </Link>
          <Link to="/my/payments">
            <span>
              <ArrowDownLeft size={19} /> 付款记录
            </span>
            <ChevronRight size={18} />
          </Link>
        </aside>
      </div>

      <button
        className="work-text-link work-account-signout"
        type="button"
        disabled={logout.isPending}
        onClick={() => {
          logout.mutate();
        }}
      >
        退出登录
      </button>
      {upgrade && (
        <Dialog
          title="升级为普通账号"
          onClose={() => setUpgrade(false)}
          footer={
            <>
              <button
                className="button secondary"
                type="button"
                onClick={() => setUpgrade(false)}
              >
                暂不升级
              </button>
              <button
                className="button"
                type="button"
                onClick={() => {
                  window.location.assign(getUpgradeHref("/account"));
                }}
              >
                通过官方 Connect 升级 <ArrowRight size={16} />
              </button>
            </>
          }
        >
          <p>通过本站官方 Connect 成功登录后，即可使用 LDC 奖励与限时开奖。</p>
          <p className="muted">升级保留当前账号的活动和领取记录。</p>
        </Dialog>
      )}
    </div>
  );
}
