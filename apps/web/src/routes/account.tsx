import { createFileRoute, Link } from "@tanstack/react-router";
import {
  ArrowDownLeft,
  ChevronRight,
  Copy,
  FileText,
  Gift,
  KeyRound,
} from "lucide-react";
import { LoginOptions } from "../components/auth/login-options";
import { useAppLogout } from "../components/auth/session-actions";
import { Help } from "../components/presentation/context-help";
import {
  PageSkeleton,
  RefreshNotice,
} from "../components/presentation/loading";
import { ActionButton } from "../components/ui/action-feedback";
import { CopyButton } from "../components/ui/copy-button";
import { UserAvatar } from "../components/user-identity";
import { useAccountProfile } from "../lib/account-profile";
import {
  getAuthErrorMessage,
  getLoginHref,
  isAuthUnavailable,
  sessionIdentity,
  useSession,
} from "../lib/auth";
import { isBlockingQueryError } from "../lib/query-view";
import { PageTitle } from "../prototype-ui/workbench-ui";
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
  const authErrorCode = new URLSearchParams(window.location.search).get(
    "authError",
  );
  const authError = getAuthErrorMessage(authErrorCode);
  const user = session.error ? null : session.data?.user;
  const profile = useAccountProfile(user ?? null);
  const identity = sessionIdentity(user ?? null);
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
          <p>@{user.username}</p>
        </div>
        <button
          className="button secondary"
          type="button"
          disabled={isAuthUnavailable(authErrorCode)}
          onClick={() => window.location.assign(getLoginHref("/account"))}
        >
          刷新资料
        </button>
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
                  "Connect 尚未提供邮箱"
                ) : (
                  <>
                    <span style={{ minWidth: 0, overflowWrap: "anywhere" }}>
                      {connectEmail}
                    </span>
                    <CopyButton
                      className="button ghost"
                      label="复制"
                      aria-label="复制 Connect 邮箱"
                      icon={<Copy size={16} aria-hidden="true" />}
                      getText={() => connectEmail}
                      scope={`${identity ?? "guest"}:${connectEmail}`}
                      style={{
                        height: 44,
                        minHeight: 44,
                        paddingInline: 10,
                        flexShrink: 0,
                      }}
                    />
                  </>
                )}
              </dd>
            </div>
          </dl>
          <RefreshNotice query={profile} />
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

      <ActionButton
        className="work-text-link work-account-signout"
        label="退出登录"
        feedback={logout.feedback}
        reserve={["退出失败"]}
        disabled={logout.isPending}
        onClick={() => {
          logout.mutate();
        }}
      />
    </div>
  );
}
