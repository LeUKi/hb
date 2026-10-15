// What went wrong when LINUX DO sends someone back without a session
// (?authError=…). Production's getAuthErrorMessage, minus the 青春版 /
// LiteAuth and 升级 cases that no longer exist.

export type AuthError = {
  text: string;
  /** The same failure for 刷新资料 (/me), where the session stays. */
  refresh: string;
  tone: "neutral" | "warning" | "danger";
  /** Signing in cannot work right now: the button waits. */
  unavailable: boolean;
};

export function authErrorOf(code: string): AuthError {
  if (code === "access_denied" || code === "cancelled")
    return {
      text: "登录已取消，可以重新尝试。",
      refresh: "刷新已取消。",
      tone: "neutral",
      unavailable: false,
    };
  if (
    code === "auth_not_configured" ||
    code === "provider_unavailable" ||
    code === "oauth_not_configured" ||
    code === "service_unavailable"
  )
    return {
      text: "登录服务暂时不可用，请稍后再试。",
      refresh: "登录服务暂时不可用，请稍后再刷新。",
      tone: "warning",
      unavailable: code === "auth_not_configured",
    };
  if (code === "invalid_state")
    return {
      text: "登录会话已失效，请重新登录。",
      refresh: "这次刷新已失效，再点一次“刷新资料”。",
      tone: "warning",
      unavailable: false,
    };
  return {
    text: "登录没有完成，请重新尝试。",
    refresh: "刷新没有完成，可以再试一次。",
    tone: "danger",
    unavailable: false,
  };
}
