// 每日一题：一天一道题，当天答对的领，每天有几份名额。
// - 第 1 行是开放当天（北京时间）的题，往后一天一行；题目和答案保密。
// - 当天的名额按已领记录里当天领的数；领过的人平台不会再交给代码。
// - 答错时回复里告诉他今天的题；每人最多答几次是参数。
// 金额都是整数，单位是分。

export const meta = {
  name: "每日一题",
  description: "每天一道题，当天答对的领，每天有名额",
};

export const params = [
  {
    key: "questions",
    label: "每天的题",
    hint: "第 1 行是开放当天的题，往后一天一行",
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
    key: "perDay",
    label: "每天几份",
    type: "integer",
    min: 1,
    max: 1000,
    default: 3,
  },
  {
    key: "tries",
    label: "每人最多答几次",
    type: "integer",
    min: 1,
    max: 20,
    default: 5,
  },
];

export const hongbao = {
  deadline: { value: 7, unit: "days" },
  prompt: "输入今天这道题的答案",
};

/**
 * @typedef {{ question: string, answer: string }} Row
 * @typedef {{ questions: Row[], perDay: number, tries: number }} Daily
 */

/**
 * @param {import("../../judge").Params} params
 * @param {{ count: number }} hongbao
 */
export function check(params, hongbao) {
  const { questions, perDay } = /** @type {Daily} */ (params);
  return questions.length * perDay < hongbao.count
    ? [
        {
          key: "perDay",
          message: `${questions.length} 道题、每天 ${perDay} 份，发不完 ${hongbao.count} 份`,
        },
      ]
    : [];
}

const day = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" });

/** The day in 北京时间, counted from 1970-01-01. */
const dayOf = (ms) => Math.floor(Date.parse(day.format(ms)) / 86400000);

/**
 * @param {import("../../judge").Submission} submission
 * @param {import("../../judge").Tools} tools
 * @returns {import("../../judge").Verdict}
 */
export function judge(submission, tools) {
  const { input, user, now, claims, hongbao } = submission;
  const { questions, perDay, tries } = /** @type {Daily} */ (submission.params);
  const today = dayOf(now);
  const row = questions[today - dayOf(hongbao.openedAt)];
  if (!row) return { ok: false, message: "题都出完了" };
  if (claims.filter((claim) => dayOf(claim.at) === today).length >= perDay)
    return { ok: false, message: `今天的 ${perDay} 份发完了，明天再来` };
  if (user.attempts >= tries)
    return { ok: false, message: `已经答了 ${tries} 次，不能再答了` };
  if (tools.text.normalize(input) === tools.text.normalize(row.answer))
    return { ok: true, amount: tools.money.even(), message: "答对了！" };
  return { ok: false, message: `不对。今天的题：${row.question}` };
}
