/**
 * What the things new people ask about mean, said once for every place that
 * explains them (docs/redesign/07-pages.md §1, 名词解释).
 */
export const glossary = {
  统计口令尝试:
    "开启了“统计口令尝试”的红包，发红包的人能看到大家试过哪些口令（按口令汇总，看不到是谁试的），所以只能在它的红包页输入口令领取，在别处输入匹配不到它。",
  红包页:
    "红包页是每个红包自己的页面，地址是 /🧧/ 后面跟 14 个表情，比如 /🧧/🔕🐋🌲…☕。帖子里看到这样一串，复制后粘贴到本站的输入框就能打开；也可以直接打开红包链接。",
} as const;

export type GlossaryTerm = keyof typeof glossary;
