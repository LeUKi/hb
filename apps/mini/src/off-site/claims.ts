// Built in place of apps/web/src/lib/claims.ts (vite.config.ts): 重新发送
// needs a session on 红包站, and the mini app leaves it out
// (lib/embedded.ts). Nothing here reaches the network.
export function useResendPayment(): never {
  throw new Error("重新发送要到红包站。");
}
