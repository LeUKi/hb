import {
  amountToMinor,
  boundedMeanLimits,
  formatAmount,
  ldcMoneySchema,
  type RandomLdcMoney,
} from "@hb/contracts";

export function RandomMoneySummary({
  money,
  opened = false,
}: {
  money: RandomLdcMoney;
  opened?: boolean;
}) {
  const checked = ldcMoneySchema.safeParse(money);
  const bounds =
    money.algorithm === "bounded_mean_v1" && checked.success
      ? boundedMeanLimits(amountToMinor(money.totalAmount), money.count)
      : null;
  return (
    <div className="space-y-2 rounded-md bg-neutral-50 p-3 text-sm leading-6">
      <p className="font-medium">
        {money.algorithm === "double_mean_v1"
          ? "二倍均值法"
          : "波动均值法（预生成）"}
      </p>
      <p>
        {money.algorithm === "double_mean_v1"
          ? "按剩余金额与份数计算二倍均值上限，逐份随机生成，为后续每份保留至少 0.01 LDC；最后一份取剩余金额。"
          : "围绕初始平均金额的 50%–150% 设置范围，边界按分向外取整，最低 0.01 LDC；生成时保留后续份额所需金额。"}
      </p>
      {bounds ? (
        <p>
          每份金额范围：{formatAmount(bounds.min)}–{formatAmount(bounds.max)}{" "}
          LDC
        </p>
      ) : null}
      <p>全部金额之和等于总发放金额，领取时随机抽取且不放回。</p>
      <p className="text-neutral-600">
        {opened
          ? "金额已固定，领取和付款重试不会重新生成。"
          : "保存草稿时生成金额；修改总额、份数或算法会重新生成，其他修改保留原金额。开放后固定。"}
      </p>
    </div>
  );
}
