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
      return `红包作者在 ${system.host} 的余额不足，红包已结束，本次奖励发放已终止。`;
    case "key_invalid":
    case "key_removed":
      return `红包作者在 ${system.host} 的密钥已失效，红包已结束，本次奖励发放已终止。`;
    case "stopped":
      return "这个红包因无法继续发放已结束，本次奖励发放已终止。";
    case "retired":
      return `「${system.name}」已下架，本次奖励发放已终止。`;
    case "not_allowed":
      return system.notAllowed || `${system.host} 拒绝向你发放本次奖励。`;
    case "bad_request":
    case "conflict":
      return `${system.host} 拒绝了本次发放，站长将进行核对。`;
    case "network":
      return `持续无法连接 ${system.host}，本次奖励发放已终止。`;
    case "recipient":
      return `${system.host} 未找到你的账户，本次奖励发放已终止。`;
    case "admin":
      return "站长核对后确认本次奖励未发放，发放已终止。";
    case "unknown":
      return `尚未确认 ${system.host} 是否已收到本次发放，站长将进行核对。`;
    default:
      return null;
  }
}

/** 操作记录 (§17): what happened, in the 站长's words. */
export const POINTS_EVENT_WORDS: Record<string, string> = {
  submit: "提交审核",
  approve: "审核通过，上线",
  return: "审核退回",
  pause: "暂停",
  resume: "恢复",
  retire: "下架",
  endpoint: "改了接口地址或最小单位",
  rate: "改了每秒最多调用",
  profile: "改了名称",
  breaker: "熔断",
  breaker_end: "熔断结束，接口又有回复了",
  test_passed: "接口测试通过",
  test_failed: "接口测试没通过",
  payout_requery: "让一笔结果不明的发放再查一次",
  payout_failed: "把一笔结果不明的发放标为发放失败",
};

/** One event in a line: what, and its note. */
export function pointsEventLine(action: string, note: string | null) {
  // A setting's note names it already: "每秒最多调用 10 → 5".
  if (
    note &&
    (action === "endpoint" || action === "rate" || action === "profile")
  )
    return `改了${note}`;
  const what = POINTS_EVENT_WORDS[action] ?? action;
  return note ? `${what}：${note}` : what;
}
