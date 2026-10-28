// What 🐟额 PLUS adds (docs/balance-design.md §13), written only here and
// sent only to those who may read it (plus.ts, the invitation's page).

export type PlusFeature = { name: string; text: string };

/**
 * PLUS 多出, in the bubble and on the invitation's page alike. 代码判定红包
 * is everyone's since 2026-10-28: PLUS deploys more a day (`deploys`, 判定器设置).
 */
export function plusFeatures(deploys: number, owner = false): PlusFeature[] {
  return [
    owner
      ? { name: "补加和扣回", text: "给自己记🐟" }
      : { name: "转入", text: "把 Credit 的 LDC 转进🐟额" },
    { name: "转账", text: "转给别人的🐟额或 Credit 账户" },
    { name: "开放接口", text: "接入网站或程序" },
    { name: "代码判定红包", text: `每天能部署 ${deploys} 次` },
    { name: "附带网页", text: "在红包页旁边放一个自己的网页" },
    { name: "邀请", text: "请别人也开通" },
  ];
}
