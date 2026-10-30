// 答题：发红包的人写一张题目和答案的表，每人抽一道，答对的领一份。
// - 题目和答案都是保密参数，结束后公开。
// - 每人的题用 tools.userRandom 抽：同一个人提交几次都是同一道。
// - 第一次提交时，回复里告诉他题目，题目也写进只给他看的数据（player.view），
//   红包页上一直看得到；之后最多再答几次是参数，答满了就结算（没领到）。
// - 答案比较前用 tools.text.normalize：不分大小写和全半角，空白合并。
// - 奖池按“几个人能领”平均分，答对就结算；分完红包自动结束。
// 金额都是整数，单位是分。

export const meta = {
  name: "答题",
  description: "每人抽一道题，答对的领一份",
};

export const params = [
  {
    key: "questions",
    label: "题目和答案",
    hint: "每人随机抽一道；答案不分大小写和全半角",
    type: "table",
    secret: true,
    columns: [
      { key: "question", label: "题目", type: "text", maxLength: 60 },
      { key: "answer", label: "答案", type: "text", maxLength: 40 },
    ],
    minRows: 1,
    maxRows: 100,
  },
  {
    key: "tries",
    label: "每人最多答几次",
    hint: "看到题目以后",
    type: "integer",
    min: 1,
    max: 10,
    default: 3,
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
  prompt: "第一次随便输入，回复里有你的题目",
};

/**
 * @typedef {{ question: string, answer: string }} Row
 * @typedef {{ questions: Row[], tries: number, winners: number }} Quiz
 */

/**
 * @param {import("../../judge").Submission} submission
 * @param {import("../../judge").Tools} tools
 * @returns {import("../../judge").Verdict}
 */
export function judge(submission, tools) {
  const { input, user } = submission;
  const { questions, tries, winners } = /** @type {Quiz} */ (submission.params);
  // The first submission only shows the question: `tries` answers after it.
  if (user.attempts > tries)
    return { message: `已经答了 ${tries} 次，不能再答了` };
  const { question, answer } = tools.userRandom.pick(questions);
  if (tools.text.normalize(input) === tools.text.normalize(answer))
    return {
      add: tools.money.even(winners),
      settle: true,
      message: "答对了！",
    };
  if (user.attempts === 0)
    return {
      message: `你的题目：${question}（能答 ${tries} 次）`,
      player: { view: { summary: `你的题目：${question}` } },
    };
  const left = tries - user.attempts;
  if (left > 0)
    return { message: `不对，还能答 ${left} 次。题目：${question}` };
  return { settle: true, message: "不对，次数用完了" };
}
