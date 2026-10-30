// 限时口令：口令按时间轮换，只有当时的那个算数。
// - 第 1 个口令从开放起用，往后每段时间换下一个；口令都保密，结束后公开。
// - 输入过期的口令，告诉他过期了；比较前用 tools.text.normalize。
// - 奖池按“几个人能领”平均分，对了就结算；分完红包自动结束。
// 金额都是整数，单位是分。

export const meta = {
  name: "限时口令",
  description: "口令按时间轮换，只有当时的口令算数",
};

export const params = [
  {
    key: "passwords",
    label: "口令",
    hint: "第 1 个从开放起用，往后每段时间换下一个",
    type: "list",
    secret: true,
    minItems: 1,
    maxItems: 100,
    maxLength: 40,
  },
  {
    key: "minutes",
    label: "每个口令用几分钟",
    type: "integer",
    min: 1,
    max: 1440,
    default: 10,
  },
  {
    key: "winners",
    label: "几个人能领",
    hint: "奖池按这么多份平均分",
    type: "integer",
    min: 1,
    max: 1000,
    default: 10,
  },
];

export const hongbao = {
  prompt: "输入现在的口令",
};

/** @typedef {{ passwords: string[], minutes: number, winners: number }} Timed */

/**
 * @param {import("../../judge").Submission} submission
 * @param {import("../../judge").Tools} tools
 * @returns {import("../../judge").Verdict}
 */
export function judge(submission, tools) {
  const { input, now, hongbao } = submission;
  const { passwords, minutes, winners } = /** @type {Timed} */ (
    submission.params
  );
  const index = Math.floor((now - hongbao.openedAt) / (minutes * 60000));
  const typed = tools.text.normalize(input);
  const same = (password) => tools.text.normalize(password) === typed;
  if (index >= passwords.length) return { message: "口令都过期了" };
  if (same(passwords[index]))
    return { add: tools.money.even(winners), settle: true, message: "对了！" };
  if (passwords.slice(0, index).some(same))
    return { message: "这个口令已经过期了" };
  return { message: "口令不对" };
}
