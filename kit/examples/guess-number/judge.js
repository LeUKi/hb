// 猜数字：发红包的人定最大值和答案，从 1 猜到最大，猜中的领一份。
// - 答案是保密参数：开放时只公布封存值，结束后公开。
// - 每人最多猜几次也是参数：平台不限次数，代码按 user.attempts 自己数。
// - 回复“大了”“小了”和还能猜几次；钱平均分。
// 金额都是整数，单位是分。

export const meta = {
  name: "猜数字",
  description: "猜 1 到最大值之间的整数，猜中的领一份",
};

export const params = [
  {
    key: "max",
    label: "最大",
    hint: "从 1 猜到这个数",
    type: "integer",
    min: 2,
    max: 1000000,
    default: 100,
  },
  {
    key: "answer",
    label: "答案",
    hint: "1 到最大之间",
    type: "integer",
    min: 1,
    max: 1000000,
    secret: true,
  },
  {
    key: "tries",
    label: "每人最多猜几次",
    type: "integer",
    min: 1,
    max: 100,
    default: 5,
  },
];

export const hongbao = {
  count: { default: 5 },
  prompt: "猜一个整数",
};

/** @typedef {{ max: number, answer: number, tries: number }} Guess */

/** @param {import("../../judge").Params} params */
export function check(params) {
  const { max, answer } = /** @type {Guess} */ (params);
  return answer > max
    ? [{ key: "answer", message: `答案不能大于最大（${max}）` }]
    : [];
}

/**
 * @param {import("../../judge").Submission} submission
 * @param {import("../../judge").Tools} tools
 * @returns {import("../../judge").Verdict}
 */
export function judge(submission, tools) {
  const { input, user } = submission;
  const { max, answer, tries } = /** @type {Guess} */ (submission.params);
  if (user.attempts >= tries)
    return { ok: false, message: `已经猜了 ${tries} 次，不能再猜了` };
  const guess = /^\d+$/.test(input) ? Number(input) : 0;
  if (guess < 1 || guess > max)
    return { ok: false, message: `请输入 1 到 ${max} 之间的整数` };
  if (guess === answer)
    return { ok: true, amount: tools.money.even(), message: "猜中了！" };
  const left = tries - user.attempts - 1;
  const hint = guess > answer ? "大了" : "小了";
  return {
    ok: false,
    message: left > 0 ? `${hint}，还能猜 ${left} 次` : `${hint}，次数用完了`,
  };
}
