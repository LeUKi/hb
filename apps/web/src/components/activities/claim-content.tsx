import { type ClaimDetail, paymentLabel } from "@hb/contracts";
import { useState } from "react";
import { formatTime } from "../../lib/activities";
import { paymentReason } from "../../lib/payment-display";
import { Button } from "../ui/button";
import { SafeMarkdown } from "./markdown";

export function ClaimContent({ claim }: { claim: ClaimDetail }) {
  const [copyStatus, setCopyStatus] = useState<string | null>(null);
  async function copy() {
    if (claim.rewardType !== "text") return;
    try {
      await navigator.clipboard.writeText(claim.text);
      setCopyStatus("奖励已复制。");
    } catch {
      setCopyStatus("复制失败，请选中下方奖励文本手动复制。");
    }
  }
  return (
    <section className="space-y-5" aria-label="我的奖励">
      <div className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-lg font-semibold">已领取奖励</h2>
          {claim.rewardType === "text" ? (
            <Button
              type="button"
              variant="secondary"
              onClick={() => void copy()}
            >
              复制奖励
            </Button>
          ) : null}
        </div>
        <p className="text-sm text-neutral-500">
          领取时间：{formatTime(claim.claimedAt)}
        </p>
        {claim.rewardType === "text" ? (
          <pre className="whitespace-pre-wrap break-words rounded-md border border-neutral-200 bg-neutral-50 p-4 text-sm leading-7 [overflow-wrap:anywhere]">
            {claim.text}
          </pre>
        ) : (
          <div className="space-y-3 rounded-md border border-amber-200 bg-amber-50 p-4">
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
              <p className="text-sm text-amber-900">
                本地模拟付款，不会产生真实 LDC 转账。
              </p>
            ) : null}
            <p className="text-xs text-neutral-600">
              金额为发放金额；收款手续费由领取者承担。
            </p>
            {claim.payment.reason ? (
              <p className="text-sm">{paymentReason(claim.payment.reason)}</p>
            ) : null}
          </div>
        )}
        {copyStatus ? (
          <p role="status" className="text-sm text-neutral-600">
            {copyStatus}
          </p>
        ) : null}
      </div>
      {claim.afterClaimInfo ? (
        <section className="space-y-3 border-t border-neutral-200 pt-4">
          <h2 className="font-semibold">领取后说明</h2>
          <SafeMarkdown>{claim.afterClaimInfo}</SafeMarkdown>
        </section>
      ) : null}
    </section>
  );
}
