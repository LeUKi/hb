// 按等级发：按 LINUX DO 信任等级发不同的金额，可以再加一个口令。
// - 每个等级一个金额参数，不填就是这个等级不发。
// - 填了口令，输入要和它一样（不分大小写和全半角）才发。
// - 平台会把金额拉进这一份能发的范围（见 AGENTS.md 的“金额怎么发”）。
// 金额都是整数，单位是分。

export const meta = {
  name: "按等级发",
  description: "按信任等级发不同的金额",
};

const levels = [0, 1, 2, 3, 4];

export const params = [
  {
    key: "password",
    label: "口令",
    hint: "填了就要输入对才发",
    type: "text",
    maxLength: 40,
    required: false,
  },
  ...levels.map((level) => ({
    key: `lv${level}`,
    label: `${level} 级发多少`,
    hint: "不填就不发",
    type: "money",
    min: 1,
    required: false,
  })),
];

export const hongbao = {
  prompt: "输入口令",
  humanCheck: true,
};

/** @param {import("../../judge").Params} params */
export function check(params) {
  return levels.every((level) => params[`lv${level}`] === null)
    ? [{ key: "lv1", message: "至少给一个等级填金额" }]
    : [];
}

/**
 * @param {import("../../judge").Submission} submission
 * @param {import("../../judge").Tools} tools
 * @returns {import("../../judge").Verdict}
 */
export function judge(submission, tools) {
  const { input, user, params } = submission;
  const password = /** @type {string | null} */ (params.password);
  if (
    password &&
    tools.text.normalize(input) !== tools.text.normalize(password)
  )
    return { message: "口令不对" };
  if (user.level === null) return { message: "看不到你的信任等级，发不了" };
  const amount = /** @type {number | null} */ (params[`lv${user.level}`]);
  if (amount === null) return { message: `${user.level} 级没有这个红包` };
  return {
    add: amount,
    settle: true,
    message: `${user.level} 级，发 ${tools.money.format(amount)}`,
  };
}
