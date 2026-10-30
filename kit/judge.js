// 示例玩法：猜暗号。改成你自己的玩法，再改 tests.json 和 simulate.json。
// - 每人最多猜 3 次：平台不限次数，代码按 user.attempts 自己数；
//   3 次都没猜中就给他结算（没领到），他不用再来。
// - 前三个猜中的各领 20.00，之后猜中的拼手气（微信同款），奖池按 10 份算，
//   用 tools.random，红包结束后公开种子，谁都能重放核对。
// - 猜中就加钱并且马上结算：每个人在一个红包里只结算一次。
// - 回复告诉对方还能猜几次。
// 金额都是整数，单位是分：2000 就是 20.00。

const ANSWER = "flag{n0t_s0_s1mpl3}";
const TRIES = 3;
const FIRST = 3;
const FIRST_AMOUNT = 2000;
const SHARES = 10;

/**
 * 每次有人提交，平台调用一次。
 * @param {import("./judge").Submission} submission
 * @param {import("./judge").Tools} tools
 * @returns {import("./judge").Verdict}
 */
export function judge(submission, tools) {
  const { input, user, claims } = submission;
  if (user.attempts >= TRIES)
    return { message: `已经猜了 ${TRIES} 次，不能再猜了` };
  if (input !== ANSWER) {
    const left = TRIES - user.attempts - 1;
    if (left > 0) return { message: `不对，还能猜 ${left} 次` };
    return { settle: true, message: "不对，次数用完了" };
  }
  if (claims.length < FIRST)
    return {
      add: FIRST_AMOUNT,
      settle: true,
      message: `第 ${claims.length + 1} 个猜中！`,
    };
  return {
    add: tools.money.lucky("double", SHARES),
    settle: true,
    message: "猜中了，拼手气",
  };
}
