import {
  type MerchantPaymentDetail,
  PAYMENT_RESEND_MINUTES,
  PAYOUT_FUNDS_WAIT_DAYS,
  type PaymentView,
} from "@hb/contracts";
import { openingLabel } from "./roster-time";

/**
 * 发放失败, and why: one sentence for each page that shows it (sweep
 * 2026-11-21, A3; docs/payout-stop-design.md §3, §4). A claim's payment
 * ends so in two ways (migration 0070's trigger): its merchant short of
 * funds through the whole wait, or no Credit account by the end of its
 * 重新发送. The claimant reads of the 红包作者's merchant and their own
 * account; the sender and the 站长, of the 商户 and the 收款人.
 */
export function failedPaymentNote(
  payment: Pick<PaymentView, "reason">,
  reader: "claimant" | "sender" = "sender",
) {
  const claimant = reader === "claimant";
  if (payment.reason === "funds")
    return claimant
      ? `红包作者的 LDC 商户余额不足，系统自动重试 ${PAYOUT_FUNDS_WAIT_DAYS} 天仍未成功，本次奖励发放已终止。`
      : `商户余额不足，系统自动重试 ${PAYOUT_FUNDS_WAIT_DAYS} 天仍未成功，本次发放已终止。`;
  if (payment.reason === "recipient")
    return claimant
      ? "LINUX DO Credit 站未找到你的账户，重新发送期限已过，本次奖励发放已终止。"
      : "收款人没有 LINUX DO Credit 账户，重新发送期限已过，本次发放已终止。";
  // Any other reason: that it is over, without guessing why.
  return "本次发放已终止，奖励没有发出。";
}

/** 发放暂停 for funds: until when it is retried (payout-stop §3). */
export function fundsWaitNote(stopAt: string) {
  return `红包作者的 LDC 商户余额不足，奖励暂未发放。系统将自动重试，直至 ${openingLabel(Date.parse(stopAt))}；届时仍未成功，本次发放将终止。`;
}

/** 发放暂停 for the day's limit: when it goes on (payout-stop §3). */
export function quotaNote(resumeAt?: string) {
  const when = quotaResumeWords(resumeAt);
  return `红包作者今日在 Credit 站的发放额度已用完，系统将${when === "稍后" ? "稍后" : `于${when}`}自动继续发放。`;
}

export function paymentAttemptOutcome(outcome: string) {
  const labels: Record<string, string> = {
    started: "进行中",
    succeeded: "已收到有效响应",
    rejected: "请求未通过",
    unknown: "结果尚未明确",
  };
  return labels[outcome] ?? "等待核对";
}

/**
 * A payment's reason code in words. A code with no words of its own gets
 * `fallback`: the merchant's catch-all, unless the caller has a better one.
 */
export function paymentReason(
  reason: string | null,
  fallback: string | null = "付款任务正在等待处理，请查看商户状态。",
) {
  if (!reason) return null;
  const labels: Record<string, string> = {
    unknown: "付款结果尚未明确，正在核对原订单。",
    funds: "LDC 商户余额不足，奖励暂未发放，系统将自动重试。",
    quota:
      "今日在 Credit 站的发放额度已用完，系统将于明天 0 点后自动继续发放。",
    credentials:
      "商户的 Client ID 或密钥未通过检查，发放已暂停，等待红包作者更新。",
    conflict: "订单信息冲突，需要检查原订单。",
    query_unavailable: "查单暂不可用，系统会继续核对。",
    query_delayed: "订单查询有延迟，系统会继续核对。",
    checking_not_found: "暂未查到原订单，系统会继续安全核对。",
    interrupted: "处理过程已中断，系统会继续核对原订单。",
    network: "网络连接失败，尚未取得可确认的结果，将继续核对原订单。",
    timeout: "请求超时，尚未取得可确认的结果，将继续核对原订单。",
    http: "上游返回非成功 HTTP 状态，付款结果仍需核对原订单。",
    redirect: "上游返回重定向，系统未继续请求，将保留原订单核对。",
    invalid_response: "上游响应格式无法识别，付款结果仍需核对原订单。",
    recipient: `收款人还没有 LINUX DO Credit 账户，发放已暂停；领取者可在 ${PAYMENT_RESEND_MINUTES} 分钟内注册后重新发送一次，逾期本次发放将终止。`,
    resend: "领取者已重新发送，系统先核对原订单再发放。",
    self_payment: "上游拒绝向同一付款账号发放，发送已暂停。",
    configuration: "上游付款配置不可用，发送已暂停。",
    validation: "上游拒绝订单参数，发送已暂停。",
    throttled: "上游暂时限流，将按允许的时间继续处理。",
    upstream_pending: "已查到订单，但上游尚未确认完成；继续查单。",
    duplicate_order: "上游已观察到相同业务号的订单；继续核对原订单。",
    retry_not_authorized: "当前任务没有可用的原单恢复授权。",
    retry_expired: "原单恢复授权已到期，只保留安全核对。",
    retry_revoked: "原单恢复授权已撤销，只保留安全核对。",
    retry_exhausted: "原单恢复授权次数已用尽，只保留安全核对。",
    order_observed: "已观察到原订单，停止恢复发送并继续核对。",
    query_required: "需要先核对原业务号，再决定后续处理。",
    send_blocked: "订单存在发送限制，系统仅继续安全核对。",
    not_due: "尚未到既定发送时间。",
    unsupported: "此任务不支持当前恢复操作。",
    probe_query_required: "重复请求已返回原订单，继续核对后台交易记录。",
    probe_protocol_unverified: "原订单查单已确认，重复请求的协议响应仍需核实。",
    probe_backend_evidence_required: "协议核对已完成，等待后台交易记录核验。",
    probe_duplicate: "重复请求已识别到原业务号，等待独立查单核对。",
    probe_receipt: "重复请求已返回订单响应，等待独立查单核对。",
    probe_inconclusive: "重复请求验证证据不足，保留原订单信息。",
    probe_timeout: "重复请求验证未在规定时间内取得完整证据。",
    disabled: "当前运行环境未启用此真实付款操作。",
    real_disabled: "当前运行环境未启用真实付款。",
    credential_unverified:
      "当前凭证尚未通过检查，奖励已锁定，等待检查后恢复付款。",
    credential_checking: "当前凭证正在检查，奖励已锁定，等待检查后恢复付款。",
    credential_rejected:
      "当前凭证认证未通过，奖励已锁定，等待红包作者更新密钥。",
    credential_unavailable: "当前凭证暂时无法验证，奖励已锁定，等待恢复付款。",
  };
  return labels[reason] ?? fallback;
}

export function paymentNextAction(action: MerchantPaymentDetail["nextAction"]) {
  return { query: "核对原订单", send: "等待按计划发送", none: "无待执行操作" }[
    action
  ];
}

export function paymentOrderEvidence(
  evidence: MerchantPaymentDetail["orderEvidence"],
) {
  if (!evidence) return "尚未观察到订单";
  return {
    receipt: "分发响应已返回订单",
    query: "查单已返回订单",
    duplicate: "上游已返回相同业务号订单",
  }[evidence];
}

export function duplicateProbeActive(
  probe: MerchantPaymentDetail["duplicateProbe"],
) {
  return (
    probe !== null &&
    ["pending", "sending", "reconciling", "awaiting_evidence"].includes(
      probe.status,
    )
  );
}

/** Why a merchant's 密钥 check did not pass. */
export function credentialReason(reason: string | null) {
  const labels: Record<string, string> = {
    credentials: "凭证认证未通过，请核对 Client ID 和密钥。",
    configuration: "商户配置无法用于验证，请核对 Client ID 和密钥。",
    interrupted: "凭证验证已中断，暂时无法确认结果。",
    network: "网络连接失败，暂时无法验证凭证。",
    timeout: "验证请求超时，暂时无法确认凭证。",
    http: "上游暂时无法完成凭证验证。",
    redirect: "凭证验证返回了重定向，暂时无法确认结果。",
    invalid_response: "上游响应格式无法识别，暂时无法验证凭证。",
  };
  return (reason && labels[reason]) || "凭证暂时无法确认，请稍后再查看。";
}

/**
 * When a merchant stopped by Credit's daily limit sends again, in words:
 * past midnight in Shanghai (where Credit's day turns), or in a few
 * minutes when that midnight has just passed.
 */
export function quotaResumeWords(resumeAt?: string, now = Date.now()) {
  const at = resumeAt ? Date.parse(resumeAt) : Number.NaN;
  if (!Number.isFinite(at)) return "0 点额度恢复后";
  const day = (ms: number) => Math.floor((ms + 8 * 3_600_000) / 86_400_000);
  if (at <= now) return "稍后";
  return day(at) > day(now) ? "明天 0 点后" : "几分钟后";
}

/** A merchant's sending is paused: why, briefly, and what happens next. */
export function merchantPause(
  reason: string,
  /**
   * For the daily limit: when it sends again, and how many wait for it;
   * for funds, when its unsent payments stop (payout-stop §4).
   */
  quota: { resumeAt?: string; queued?: number; stopAt?: string } = {},
) {
  const short: Record<string, string> = {
    funds: "商户余额不足",
    quota: "今日在 Credit 站的发放额度已用完",
    credentials: "商户的 Client ID 或密钥未通过检查",
    credential_rejected: "商户的 Client ID 或密钥未通过检查",
    unknown: "发放结果尚未明确",
  };
  const queued = quota.queued ? `，${quota.queued} 笔在排队` : "";
  const when = quotaResumeWords(quota.resumeAt);
  return {
    title: `发放已暂停：${short[reason] ?? (paymentReason(reason) ?? "").replace(/。$/u, "")}`,
    text:
      reason === "funds"
        ? `在 Credit 站补足余额后，系统将自动继续发放${queued}，无需在此操作。在此期间，用这个商户发的红包暂停领取，也不能开放新红包。${
            quota.stopAt
              ? `系统将自动重试至 ${openingLabel(Date.parse(quota.stopAt))}；届时仍未成功，未发放的奖励将终止发放，进行中的红包也将结束。`
              : ""
          }`
        : reason === "quota"
          ? `系统将${when === "稍后" ? "稍后" : `于${when}`}自动继续发放${queued}，无需在此操作。领取不受影响。`
          : "条件满足后系统将自动继续发放，无需在此操作。领取不受影响。",
  };
}
