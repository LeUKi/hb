/**
 * What the things new people ask about mean, said once for every place that
 * explains them (docs/redesign/07-pages.md §1, 名词解释).
 */
export const glossary = {
  首页领取:
    "发红包的人可以关闭首页领取：这样的红包，口令只能在它的红包页输入，在首页输入匹配不到。关闭了首页领取的红包都在红包广场里；把分享的那一整段粘贴到首页的输入框，也能直接打开领取。",
  红包页:
    "红包页是每个红包自己的页面，地址是 /🧧/ 后面跟 14 个表情，比如 /🧧/🔕🐋🌲…☕。帖子里看到这样一串（或分享的那一整段），复制后粘贴到本站的输入框就能打开；也可以直接打开红包链接。",
} as const;

export type GlossaryTerm = keyof typeof glossary;
