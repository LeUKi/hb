import {
  amountToMinor,
  boundedMeanLimits,
  formatAmount,
  ldcMoneySchema,
  type RandomLdcMoney,
} from "@hb/contracts";

export function RandomMoneySummary({ money }: { money: RandomLdcMoney }) {
  const checked = ldcMoneySchema.safeParse(money);
  const bounds =
    money.algorithm === "bounded_mean_v1" && checked.success
      ? boundedMeanLimits(amountToMinor(money.totalAmount), money.count)
      : null;
  return (
    <div className="space-y-2 rounded-md bg-panel p-3 text-sm leading-6">
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
    </div>
  );
}
