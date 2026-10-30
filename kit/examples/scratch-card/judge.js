// 刮刮乐：一张 5×5 的卡，几个格子有奖（参数），其余是“谢谢参与”。每人刮一格。
// - 哪格有奖、各是多少，开放时由 setup() 随机分好（加起来正好是总奖池），放在
//   state 里只有代码知道；Math.random() 来自封存的种子，结束后谁都能核对。
// - 刮开了哪些格子、刮出了什么公开（view），每一格写一条动态（announce）。
// - 刮一格就结算：刮到奖的领那一格的钱，谢谢参与的结算 0；每人只结算一次，
//   所以每人只能刮一格。奖都刮完了奖池就空了，红包自动结束，这时整张卡公开。
// - 配套的网页在 page/index.html。
// 金额都是整数，单位是分。

export const meta = {
  name: "刮刮乐",
  description: "5×5 的卡，每人刮一格，刮到奖的领那一格的钱",
  // 网页放到静态托管上以后，在这里写它的地址，用这个判定器发红包时一起带上：
  // page: "https://你的网页地址/",
};

/** 卡上一共几格。 */
const CELLS = 25;

export const params = [
  {
    key: "prizes",
    label: "几格有奖",
    hint: "奖池随机分成这么多个奖",
    type: "integer",
    min: 1,
    max: CELLS,
    default: 5,
  },
];

export const hongbao = {
  prompt: "选一格刮开（1–25）",
  title: "刮刮乐",
  note: "一张 5×5 的卡，有几格藏着奖，每人刮一格，刮到奖的领那一格的钱。\n\n[打开网页参与游戏](#附带网页)",
};

/**
 * @typedef {{ prizes: number[], open: (number | null)[] }} Card
 * prizes：每格的奖（分），0 是谢谢参与；open：刮开的格子是它的奖，没刮开是 null。
 */

/** 公开的部分：没刮开的格子不说；奖都刮完了，整张卡公开。 */
function viewOf(/** @type {Card} */ card) {
  const opened = card.open.filter((cell) => cell !== null).length;
  const left = card.prizes.filter(
    (prize, index) => prize > 0 && card.open[index] === null,
  ).length;
  return {
    summary:
      left === 0 ? "奖都刮完了" : `刮开了 ${opened} 格，还剩 ${left} 个奖`,
    data: {
      cells: card.open,
      left,
      ...(left === 0 ? { prizes: card.prizes } : {}),
    },
  };
}

/** 开放时：把奖池分成几个奖（每个至少 0.01），放进随机的格子。 */
export function setup(
  /** @type {import("../../judge").Params} */ params,
  /** @type {{ total: number }} */ hongbao,
) {
  const count = Number(params.prizes);
  const spare = hongbao.total - count;
  const cuts = Array.from({ length: count - 1 }, () =>
    Math.floor(Math.random() * (spare + 1)),
  ).sort((a, b) => a - b);
  const amounts = [...cuts, spare].map(
    (cut, index) => 1 + cut - (index === 0 ? 0 : cuts[index - 1]),
  );
  const order = Array.from({ length: CELLS }, (_, index) => index);
  for (let index = order.length - 1; index > 0; index -= 1) {
    const other = Math.floor(Math.random() * (index + 1));
    [order[index], order[other]] = [order[other], order[index]];
  }
  const prizes = Array(CELLS).fill(0);
  for (const [index, amount] of amounts.entries())
    prizes[order[index]] = amount;
  /** @type {Card} */
  const card = { prizes, open: Array(CELLS).fill(null) };
  return { state: card, view: viewOf(card) };
}

/** 奖池不够每个奖 0.01，就分不出这么多个奖。 */
export function check(
  /** @type {import("../../judge").Params} */ params,
  /** @type {{ total: number }} */ hongbao,
) {
  return Number(params.prizes) > hongbao.total
    ? [{ key: "prizes", message: "奖池不够每个奖 0.01" }]
    : [];
}

/**
 * @param {import("../../judge").Submission} submission
 * @param {import("../../judge").Tools} tools
 * @returns {import("../../judge").Verdict}
 */
export function judge(submission, tools) {
  const { input, user } = submission;
  const card = /** @type {Card} */ (submission.state);
  const cell = /^\d+$/.test(input) ? Number(input) : 0;
  if (cell < 1 || cell > CELLS)
    return { message: `请选 1 到 ${CELLS} 中的一格` };
  if (card.open[cell - 1] !== null)
    return { message: `第 ${cell} 格已经刮开了` };
  const prize = card.prizes[cell - 1];
  /** @type {Card} */
  const state = {
    ...card,
    open: card.open.map((open, index) => (index === cell - 1 ? prize : open)),
  };
  return {
    add: prize,
    settle: true,
    message: prize > 0 ? `刮中了 ${tools.money.format(prize)}！` : "谢谢参与",
    state,
    view: viewOf(state),
    announce: `@${user.username} 刮开第 ${cell} 格：${prize > 0 ? tools.money.format(prize) : "谢谢参与"}`,
  };
}
