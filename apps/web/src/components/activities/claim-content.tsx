import { type ClaimDetail, paymentLabel } from "@hb/contracts";
import { formatTime } from "../../lib/activities";
import { paymentReason } from "../../lib/payment-display";
import { SafeMarkdown } from "./markdown";

export function ClaimContent({ claim }: { claim: ClaimDetail }) {
  return (
    <section className="space-y-5" aria-label="我的奖励">
      <div className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-lg font-semibold">已领取奖励</h2>
        </div>
        <p className="text-sm text-subtle">
          领取时间：{formatTime(claim.claimedAt)}
        </p>
        <div className="space-y-3 rounded-md border border-warning/40 bg-warning/10 p-4">
          <p className="text-xl font-semibold">{claim.amount} LDC</p>
          <p className="text-sm font-medium">
            {paymentLabel(claim.payment.mode, claim.payment.status)}
          </p>
          {claim.payment.status !== "confirmed" ? (
            <p className="text-sm">
              奖励金额已锁定，付款等待处理；刷新或再次访问不会重新分配奖励。
            </p>
          ) : null}
          {claim.payment.mode === "simulation" ? (
            <p className="text-sm text-warning">
              本地模拟付款，不会产生真实 LDC 转账。
            </p>
          ) : null}
          <p className="text-xs text-muted">
            金额为发放金额；收款手续费由领取者承担。
          </p>
          {claim.payment.reason ? (
            <p className="text-sm">{paymentReason(claim.payment.reason)}</p>
          ) : null}
        </div>
      </div>
      {claim.afterClaimInfo ? (
        <section className="space-y-3 border-t border-separator pt-4">
          <h2 className="font-semibold">奖励附言</h2>
          <SafeMarkdown>{claim.afterClaimInfo}</SafeMarkdown>
        </section>
      ) : null}
    </section>
  );
}
