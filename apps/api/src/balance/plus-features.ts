// What 🐟额 PLUS adds (docs/balance-design.md §13), written only here and
// sent only to those who may read it (plus.ts, the invitation's page).

export type PlusFeature = { name: string; text: string };

/** PLUS's numbers from 判定器设置. */
export const plusJudgeLimits = (settings: {
  dailyOpenLimitPlus: number;
  dailyDeployLimitPlus: number;
}) => ({
  opens: settings.dailyOpenLimitPlus,
  deploys: settings.dailyDeployLimitPlus,
});

/**
 * PLUS 多出, in the bubble and on the invitation's page alike. 代码判定红包
 * is everyone's since 2026-10-28: PLUS opens and deploys more a day (判定器设置).
 */
export function plusFeatures(
  judge: { opens: number; deploys: number },
  owner = false,
): PlusFeature[] {
  return [
    owner
      ? { name: "补加和扣回", text: "给自己记🐟" }
      : { name: "转入", text: "把 Credit 的 LDC 转进🐟额" },
    { name: "转账", text: "转给别人的🐟额或 Credit 账户" },
    { name: "开放接口", text: "接入网站或程序" },
    {
      name: "代码判定红包",
      text: `每天能开放 ${judge.opens} 个、部署 ${judge.deploys} 次`,
    },
    // 打赏 (docs/tip-design.md §2): more cards, and tipping from 🐟额.
    { name: "打赏卡", text: "最多 30 张" },
    { name: "🐟额打赏", text: "用🐟额打赏别人，不用输密码" },
    { name: "邀请", text: "请别人也开通" },
  ];
}
