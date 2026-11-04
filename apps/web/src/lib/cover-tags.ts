import { levelPhrase, type PublicClaimScope, scopeTag } from "@hb/contracts";
import { glossary } from "./glossary";
import type { HongbaoActivity } from "./hongbao";
import { splitNames, splitRules } from "./hongbao-text";

// The cover's labels, in words only: the page's cover draws them as chips
// with their hints, and the forum's mini app the same (docs/mini-app-
// design.md §7).

const playNames = {
  fixed: "固定均分",
  random: "拼手气",
  custom: "自定义金额",
  timed_draw: "限时开奖",
  code: "代码判定",
} as const;

/**
 * The cover's labels, each with what it means: how to take part, the 玩法
 * (with its 分法 where money is split at random), 🐟额, 首页领取 and the
 * human check. The amounts are not repeated here: the numbers under them
 * say them.
 */
/** 领取范围 under its tag, its people named (the first ten). */
function scopeHint(scope: PublicClaimScope, verb: "领" | "报名") {
  const users = scope.users ?? [];
  const names = `${users
    .slice(0, 10)
    .map((user) => `@${user.username}`)
    .join("、")}${users.length > 10 ? ` 等 ${users.length} 人` : ""}`;
  if (scope.levels && users.length > 0)
    return `${levelPhrase(scope.levels, "的人")}能${verb}，指定的 ${names} 也能${verb}。`;
  if (scope.levels) return `${levelPhrase(scope.levels, "的人")}能${verb}。`;
  return `只有 ${names} 能${verb}。`;
}

export function coverTags(activity: HongbaoActivity) {
  const verb = activity.mode === "timed_draw" ? "报名" : "领取";
  const split = activity.split;
  const draw = "到开奖时间，从报名的人里抽出中奖者。";
  const play = {
    fixed: "每份金额一样。",
    random: split ? `${splitRules[split]}。` : "每份金额随机。",
    custom: "每份的金额由红包作者定好。",
    timed_draw: split ? `${draw}奖金分法是${splitRules[split]}。` : draw,
    code: "每次领多少由判定器判定；开放时公布它的代码指纹，结束后公开代码。",
  }[activity.mode];
  const splitName =
    split && (activity.mode === "random" || activity.mode === "timed_draw")
      ? ` · ${splitNames[split]}`
      : "";
  const playTag = {
    text: `${playNames[activity.mode]}${splitName}`,
    hint: play,
    code: activity.mode === "code",
  };
  return [
    // 代码判定 comes first, in place of 口令红包 / 无需口令 (05 §4), with
    // 联网 beside it when its code asks addresses (§9.5).
    ...(activity.mode === "code"
      ? [
          playTag,
          ...(activity.judge?.network
            ? [
                {
                  text: "联网",
                  hint: `判定时会请求这些地址：${activity.judge.network.join("、")}。判定结果取决于对方的回答，开放后对方的回答可能变化，本站无法核对。`,
                },
              ]
            : []),
        ]
      : [
          activity.participation === "password"
            ? { text: "口令红包", hint: `输入正确的口令才能${verb}。` }
            : { text: "无需口令", hint: `登录后直接${verb}，不用口令。` },
          playTag,
        ]),
    // 领取范围 (docs/claim-scope-design.md §5): who may, its people by name.
    ...(activity.scope
      ? [
          {
            text: scopeTag(activity.scope),
            hint: `这是红包作者的要求：${scopeHint(
              activity.scope,
              activity.mode === "timed_draw" ? "报名" : "领",
            )}`,
          },
        ]
      : []),
    // A 🐟额红包: where what is taken goes (docs/balance-design.md §14).
    ...(activity.fish
      ? [
          {
            text: "🐟额",
            hint: "领到的 LDC 先存进🐟额，随时可以转出到你的 Credit 账户。",
          },
        ]
      : []),
    // 首页领取 off: the 口令 works on this page only (07 §6).
    // 代码判定 is only ever on its page: no tag for it (05 §4).
    ...(activity.pageOnly && activity.mode !== "code"
      ? [{ text: "关闭首页领取", hint: glossary.首页领取 }]
      : []),
    ...(activity.humanCheck
      ? [
          {
            text: "需人机验证",
            hint:
              activity.humanCheckMethod === "cap"
                ? `这是红包作者的要求：${verb}前要先通过人机验证（Cap）。浏览器会自己算一两秒，不用点选。`
                : `这是红包作者的要求：${verb}前要先通过 Cloudflare 人机验证。中国大陆网络、广告拦截插件或部分隐私浏览器可能加载不出验证。`,
          },
        ]
      : []),
  ];
}
