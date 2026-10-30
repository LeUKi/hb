// 数字炸弹：1 到最大里埋一颗炸弹，大家轮流猜。猜过的数和安全区间公开（view），
// 每次猜都写一条动态（announce）。踩中的领一份（奖池按炸弹的颗数平均分）并且
// 马上结算，接着埋下一颗、区间重来；最后一颗踩中，奖池分完，红包自动结束。
// 配套的网页在 page/index.html。
// - 炸弹在哪只有代码知道：放在 state 里。第一颗开放时由 setup() 埋下，
//   Math.random() 来自封存的种子，结束后谁都能核对。
// - 平台不限次数，有冷却；谁都能接着猜。
// 金额都是整数，单位是分。

export const meta = {
  name: "数字炸弹",
  description: "1 到最大里藏一颗炸弹，大家轮流猜，踩中的领一份",
  // 网页放到静态托管上以后，在这里写它的地址，用这个判定器发红包时一起带上：
  // page: "https://你的网页地址/",
};

export const params = [
  {
    key: "max",
    label: "最大",
    hint: "炸弹埋在 1 到这个数之间",
    type: "integer",
    min: 10,
    max: 1000,
    default: 100,
  },
  {
    key: "bombs",
    label: "几颗炸弹",
    hint: "踩中一颗领一份，奖池按颗数平均分",
    type: "integer",
    min: 1,
    max: 100,
    default: 5,
  },
];

export const hongbao = {
  prompt: "猜一个数",
  title: "数字炸弹",
  note: "1 到最大里藏着一颗炸弹，大家轮流猜，猜过的数和安全区间都公开。踩中的领一份，接着埋下一颗。\n\n[打开网页参与游戏](#附带网页)",
};

/**
 * @typedef {{ max: number, bombs: number, bomb: number, low: number, high: number, guessed: number[], round: number }} Field
 */

/** 公开的部分：炸弹在哪不放进来。 */
function viewOf(/** @type {Field} */ field) {
  const { max, bombs, low, high, guessed, round } = field;
  return {
    summary: `第 ${round} 颗炸弹 · ${low === high ? `只剩 ${low}` : `安全区间 ${low}–${high}`}`,
    data: { max, bombs, low, high, guessed, round },
  };
}

/** 埋第几颗：区间重来。 */
function bury(
  /** @type {number} */ max,
  /** @type {number} */ bombs,
  /** @type {number} */ round,
) {
  /** @type {Field} */
  const field = {
    max,
    bombs,
    bomb: 1 + Math.floor(Math.random() * max),
    low: 1,
    high: max,
    guessed: [],
    round,
  };
  return { state: field, view: viewOf(field) };
}

/** 开放时埋下第一颗。 */
export function setup(/** @type {import("../../judge").Params} */ params) {
  return bury(Number(params.max), Number(params.bombs), 1);
}

/**
 * @param {import("../../judge").Submission} submission
 * @param {import("../../judge").Tools} tools
 * @returns {import("../../judge").Verdict}
 */
export function judge(submission, tools) {
  const { input, user } = submission;
  const field = /** @type {Field} */ (submission.state);
  const guess = /^\d+$/.test(input) ? Number(input) : 0;
  if (guess < field.low || guess > field.high)
    return { message: `请猜 ${field.low} 到 ${field.high} 之间的整数` };
  if (guess === field.bomb) {
    // 最后一颗：不用再埋了，奖池也分完了。
    if (field.round >= field.bombs)
      return {
        add: tools.money.even(field.bombs),
        settle: true,
        message: "踩中了最后一颗炸弹！",
        view: {
          summary: `第 ${field.round} 颗炸弹被踩中，红包领完了`,
          data: { ...viewOf(field).data, done: true },
        },
        announce: `@${user.username} 踩中了最后一颗炸弹`,
      };
    const next = bury(field.max, field.bombs, field.round + 1);
    return {
      add: tools.money.even(field.bombs),
      settle: true,
      message: "踩中了炸弹！",
      ...next,
      announce: `@${user.username} 踩中了炸弹，领到一份，第 ${field.round + 1} 颗已经埋好`,
    };
  }
  const low = guess < field.bomb ? guess + 1 : field.low;
  const high = guess > field.bomb ? guess - 1 : field.high;
  /** @type {Field} */
  const state = { ...field, low, high, guessed: [...field.guessed, guess] };
  return {
    message:
      low === high
        ? `安全！只剩 ${low} 了`
        : `安全！炸弹在 ${low}–${high} 之间`,
    state,
    view: viewOf(state),
    announce: `@${user.username} 猜了 ${guess}，安全`,
  };
}
