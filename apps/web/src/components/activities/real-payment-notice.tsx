import { publicationReason } from "../../lib/payment-display";

export function RealPaymentNotice({
  draft = false,
  openingBlockedReason,
}: {
  draft?: boolean;
  openingBlockedReason?: string | null;
}) {
  const reason = publicationReason(openingBlockedReason);
  return (
    <div className="space-y-2 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm leading-6 text-amber-900">
      <p>
        {draft
          ? "真实 LDC 活动先保存为准备中。开放前，当前商户的当前凭证须在最近 10 分钟内通过检查。"
          : "真实 LDC 奖励领取成功后金额即锁定，付款异步完成；凭证失效或轮换期间，已开放活动仍可领取，付款等待恢复。"}
      </p>
      {reason ? <p>{reason}</p> : null}
    </div>
  );
}
