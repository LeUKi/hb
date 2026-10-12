import { ArrowRight, ChevronDown } from "lucide-react";
import { AnimatePresence } from "motion/react";
import { useCallback, useEffect, useId, useRef } from "react";
import { getLoginHref, isAuthUnavailable, useSession } from "../../lib/auth";
import { useViewState } from "../../lib/navigation-state";
import { AnimatedRegion } from "../presentation/animated-disclosure";

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
  const connectUnavailable = isAuthUnavailable(error, "connect");
  const liteUnavailable = isAuthUnavailable(error, "liteauth");
  const session = useSession();
  const liteauthEnabled = session.data?.loginOptions?.liteauthEnabled === true;
  const [liteOpen, setLiteOpen] = useViewState("login-lite-expanded", false);
  const connectRef = useRef<HTMLAnchorElement>(null);
  const liteRef = useCallback((node: HTMLDivElement | null) => {
    if (!node) return;
    // Ref cleanup runs before removing the focused login controls from the DOM.
    return () => {
      if (node.contains(document.activeElement))
        connectRef.current?.focus({ preventScroll: true });
    };
  }, []);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelId = useId();
  const titleId = useId();
  useEffect(() => {
    if (liteauthEnabled || !liteOpen) return;
    setLiteOpen(false);
  }, [liteauthEnabled, liteOpen, setLiteOpen]);
  useEffect(() => {
    if (!liteOpen) return;
    const close = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setLiteOpen(false);
      triggerRef.current?.focus({ preventScroll: true });
    };
    document.addEventListener("keydown", close);
    return () => document.removeEventListener("keydown", close);
  }, [liteOpen, setLiteOpen]);
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
        <a
          ref={connectRef}
          className="button work-login-primary"
          href={getLoginHref(returnTo)}
        >
          通过LINUX DO登录 <ArrowRight size={16} />
        </a>
      )}
      {liteauthEnabled && (
        <div ref={liteRef} className="work-login-lite">
          <button
            ref={triggerRef}
            className="work-login-lite-trigger"
            type="button"
            aria-expanded={liteOpen}
            aria-controls={panelId}
            onClick={() => {
              const next = !liteOpen;
              setLiteOpen(next);
              if (!next) triggerRef.current?.focus({ preventScroll: true });
            }}
          >
            <span>青春版登录</span>
            <ChevronDown
              size={17}
              aria-hidden="true"
              className={liteOpen ? "is-open" : undefined}
            />
          </button>
          <AnimatePresence initial={false}>
            {liteOpen && (
              <AnimatedRegion
                key="lite-login-panel"
                className="work-login-lite-region"
              >
                <div id={panelId} className="work-login-lite-panel">
                  <p>
                    青春版账号可登录浏览，创建、兑奖和报名需通过 LINUX DO
                    登录升级。
                  </p>
                  {liteUnavailable ? (
                    <p className="muted">LiteAuth 青春版暂不可用</p>
                  ) : (
                    <a
                      className="button secondary work-login-secondary"
                      href={getLoginHref(returnTo, "liteauth")}
                    >
                      通过 LiteAuth 登录 <ArrowRight size={16} />
                    </a>
                  )}
                </div>
              </AnimatedRegion>
            )}
          </AnimatePresence>
        </div>
      )}
    </section>
  );
}
