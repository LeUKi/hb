// 三方积分 (docs/third-party-points-design.md §5 §9): words with no request
// behind them, kept apart from lib/points.ts so the 社区's mini app (which
// builds its own stand-in for that file) has them too.

/** Why a payout of a 三方积分 did not go, in the claimant's words (§5 §9). */
export function pointsFailureWords(
  reason: string | null,
  system: { name: string; host: string; notAllowed?: string },
) {
  switch (reason) {
    case "insufficient":
      return `红包作者在 ${system.host} 的余额不够了，这笔没发出去，红包也结束了。`;
    case "key_invalid":
    case "key_removed":
      return `红包作者在 ${system.host} 的密钥失效了，这笔没发出去，红包也结束了。`;
    case "stopped":
      return "这个红包因为发不出去已经结束，这笔没有发出。";
    case "retired":
      return `「${system.name}」已经下架，这笔没有发出。`;
    case "not_allowed":
      return system.notAllowed || `${system.host} 不允许给你发这笔。`;
    case "bad_request":
    case "conflict":
      return `${system.host} 拒绝了这笔，站长会去核对。`;
    case "network":
      return `一直连不上 ${system.host}，这笔没发出去。`;
    case "recipient":
      return `${system.host} 找不到你的账户，这笔不再补发。`;
    case "admin":
      return "站长核对后确认这笔没有发出。";
    case "unknown":
      return `还不知道 ${system.host} 有没有收到这笔，站长会去核对。`;
    default:
      return null;
  }
}
