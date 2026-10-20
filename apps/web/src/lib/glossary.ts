/**
 * What the things new people ask about mean, said once for every place that
 * explains them (docs/redesign/07-pages.md §1, 名词解释).
 */
export const glossary = {
  首页领取:
    "发红包的人关闭首页领取后，口令只能在红包页输入。这类红包可在红包广场里找到入口。",
  红包页:
    "每个红包自己的页面，地址是 /🧧/ 加 14 个表情。把帖子里的这串或整段分享文字粘贴到输入框就能打开。",
} as const;

export type GlossaryTerm = keyof typeof glossary;
