// What went wrong when LINUX DO sends someone back without a session
// (?authError=…). Production's getAuthErrorMessage, minus the 青春版 /
// LiteAuth and 升级 cases that no longer exist.

export type AuthError = {
  text: string;
  tone: "neutral" | "warning" | "danger";
  /** Signing in cannot work right now: the button waits. */
  unavailable: boolean;
};

export function authErrorOf(code: string): AuthError {
  if (code === "access_denied" || code === "cancelled")
    return {
      text: "登录已取消，可以重新尝试。",
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
      tone: "warning",
      unavailable: code === "auth_not_configured",
    };
  if (code === "invalid_state")
    return {
      text: "登录会话已失效，请重新登录。",
      tone: "warning",
      unavailable: false,
    };
  return {
    text: "登录没有完成，请重新尝试。",
    tone: "danger",
    unavailable: false,
  };
}

/** The dev toolbar's sample callbacks. */
export const sampleAuthErrors: [string, string][] = [
  ["access_denied", "取消"],
  ["invalid_state", "会话失效"],
  ["service_unavailable", "服务不可用"],
  ["auth_failed", "其他失败"],
];
