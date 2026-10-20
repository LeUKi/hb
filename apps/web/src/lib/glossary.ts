/**
 * What the things new people ask about mean, said once for every place that
 * explains them (docs/redesign/07-pages.md §1, 名词解释).
 */
export const glossary = {
  仅限红包页:
    "发红包的人设置了口令只能在红包页输入，在别处输入匹配不到。这样的红包都在红包广场里：找到它，打开红包页再输入口令。",
  红包页:
    "红包页是每个红包自己的页面，地址是 /🧧/ 后面跟 14 个表情，比如 /🧧/🔕🐋🌲…☕。帖子里看到这样一串（或分享的那一整段），复制后粘贴到本站的输入框就能打开；也可以直接打开红包链接。",
} as const;

export type GlossaryTerm = keyof typeof glossary;
