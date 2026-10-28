// 前 N 个答对的：前几个答对的各拿一大份，之后答对的拼手气。
// - 答案保密，比较前用 tools.text.normalize：不分大小写和全半角。
// - 拼手气用 tools.money.lucky()（微信同款），结束后公开种子，谁都能重放。
// - 每人最多答几次是参数。
// 金额都是整数，单位是分。

export const meta = {
  name: "前 N 个答对的",
  description: "前几个答对的拿大份，之后答对的拼手气",
};

export const params = [
  {
    key: "answer",
    label: "答案",
    hint: "不分大小写和全半角",
    type: "text",
    maxLength: 100,
    secret: true,
  },
  {
    key: "first",
    label: "前几个",
    type: "integer",
    min: 1,
    max: 1000,
    default: 3,
  },
  {
    key: "firstAmount",
    label: "前几个每人发多少",
    type: "money",
    min: 1,
    default: 500,
  },
  {
    key: "tries",
    label: "每人最多答几次",
    type: "integer",
    min: 1,
    max: 100,
    default: 3,
  },
];

export const hongbao = {
  count: { default: 10 },
  prompt: "输入答案",
};

/** @typedef {{ answer: string, first: number, firstAmount: number, tries: number }} First */

/** 500 → "5.00" */
const yuan = (cents) => (cents / 100).toFixed(2);

/**
 * @param {import("../../judge").Params} params
 * @param {{ total: number, count: number, minEach: number }} hongbao
 */
export function check(params, hongbao) {
  const { first, firstAmount } = /** @type {First} */ (params);
  if (first > hongbao.count)
    return [{ key: "first", message: `不能多于份数（${hongbao.count}）` }];
  const needed =
    first * firstAmount + (hongbao.count - first) * hongbao.minEach;
  return needed > hongbao.total
    ? [
        {
          key: "firstAmount",
          message: `总奖池不够：前 ${first} 个就要 ${yuan(first * firstAmount)} LDC`,
        },
      ]
    : [];
}

/**
 * @param {import("../../judge").Submission} submission
 * @param {import("../../judge").Tools} tools
 * @returns {import("../../judge").Verdict}
 */
export function judge(submission, tools) {
  const { input, user, claims } = submission;
  const { answer, first, firstAmount, tries } = /** @type {First} */ (
    submission.params
  );
  if (user.attempts >= tries)
    return { ok: false, message: `已经答了 ${tries} 次，不能再答了` };
  if (tools.text.normalize(input) !== tools.text.normalize(answer)) {
    const left = tries - user.attempts - 1;
    return {
      ok: false,
      message: left > 0 ? `不对，还能答 ${left} 次` : "不对，次数用完了",
    };
  }
  if (claims.length < first)
    return {
      ok: true,
      amount: firstAmount,
      message: `第 ${claims.length + 1} 个答对！`,
    };
  return { ok: true, amount: tools.money.lucky(), message: "答对了，拼手气" };
}
