/**
 * What the things new people ask about mean, said once for every place that
 * explains them (docs/redesign/07-pages.md §1, 名词解释).
 */
export const glossary = {
  首页领取:
    "红包作者关闭首页领取后，口令只能在红包页输入。这类红包可在红包广场里找到入口。",
} as const;

export type GlossaryTerm = keyof typeof glossary;
