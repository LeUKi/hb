import { ArrowRight } from "lucide-react";
import { useId } from "react";
import { getLoginHref, isAuthUnavailable } from "../../lib/auth";

export function LoginOptions({
  returnTo,
  compact = false,
  notice,
}: {
  returnTo: string;
  compact?: boolean;
  notice?: string | null;
}) {
  const error = new URLSearchParams(window.location.search).get("authError");
  const connectUnavailable = isAuthUnavailable(error);
  const titleId = useId();
  if (compact)
    return connectUnavailable ? (
      <span className="muted">官方 Connect 暂不可用</span>
    ) : (
      <a className="button" href={getLoginHref(returnTo)}>
        登录
      </a>
    );
  return (
    <section className="work-login-card" aria-labelledby={titleId}>
      <div className="work-login-heading">
        <h1 id={titleId}>登录解meme</h1>
        <p>登录后即可参与活动，或管理你发起的活动。</p>
      </div>
      {notice && (
        <p className="work-form-error" role="alert">
          {notice}
        </p>
      )}
      {connectUnavailable ? (
        <p className="work-form-error">官方 Connect 暂不可用</p>
      ) : (
        <a className="button work-login-primary" href={getLoginHref(returnTo)}>
          通过LINUX DO登录 <ArrowRight size={16} />
        </a>
      )}
    </section>
  );
}
