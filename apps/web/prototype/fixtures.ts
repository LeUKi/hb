import {
  fixedPoolAmount,
  prototypeDeadlineAt,
  prototypeStartedAt,
} from "./activity-metadata";
import type {
  Activity,
  ActivityLifecycle,
  ActivityViewStateOverrides,
  Identity,
  Participation,
  ParticipationResult,
  PaymentProgress,
  RewardMode,
} from "./types";

export const activities: Activity[] = [
  {
    id: "weekend",
    title: "周末红包 · 20 份",
    author: "小满",
    username: "xiaoman",
    color: "sage",
    type: "ldc",
    description: "20 份 LDC 红包，每份 0.88 LDC。",
    topicUrl: "https://linux.do/t/topic/2964597/1216",
    beforeInfo:
      "**周末红包**\n\n每个账号可兑换一份奖励，请在活动结束前提交口令。",
    afterClaimInfo:
      "周末红包已兑换。\n\n请在活动历史中核对本次奖励，发放状态与兑换结果分别保留。",
    afterEndInfo:
      "周末红包已经结束。\n\n已有奖励继续保留；如需反馈，请访问[关联论坛回复](https://linux.do/t/2964597/1216)。",
    amount: "0.88",
    rewardMode: "fixed",
    poolAmount: "17.60",
    deadlineAt: prototypeDeadlineAt("ldc"),
    count: 20,
    remaining: 12,
    passwords: ["公共口令2026", "开奖口令2026", "周末口令2026"],
  },
  {
    id: "reading-ldc",
    title: "电子书阅读红包",
    author: "白桃",
    username: "whitepeach",
    color: "peach",
    type: "ldc",
    description: "12 份 LDC 红包，每份 0.50 LDC。",
    topicUrl: "https://linux.do/t/topic/2964597/1216",
    beforeInfo:
      "**电子书阅读红包**\n\n每个账号可领取一份 LDC 奖励，请在活动结束前提交口令。",
    afterClaimInfo:
      "电子书阅读红包已领取。\n\n请在活动历史中核对本次奖励，发放状态与兑换结果分别保留。",
    afterEndInfo:
      "本期电子书阅读红包已经结束。\n\n已有奖励继续保留，可继续查看活动记录。",
    amount: "0.50",
    rewardMode: "fixed",
    poolAmount: "6.00",
    deadlineAt: prototypeDeadlineAt("ldc"),
    count: 12,
    remaining: 8,
    passwords: ["公共口令2026", "图书口令2026"],
  },
  {
    id: "evening",
    title: "十分钟限时开奖",
    author: "阿山",
    username: "ashan",
    color: "blue",
    type: "draw",
    description: "奖池 20 LDC，最多 10 人获奖，开放后 10 分钟开奖。",
    beforeInfo:
      "**十分钟限时开奖**\n\n提交正确口令取得报名资格，中奖结果由活动发布；报名不代表获得奖励。",
    afterClaimInfo:
      "你已在十分钟限时开奖中获得奖励。\n\n本次分配结果已保留，无需等待付款确认即可查看这段附言。",
    afterEndInfo:
      "十分钟限时开奖报名已结束。\n\n如结果仍在处理中，请保留报名记录；本说明不会生成或改变开奖结果。",
    amount: "20.00",
    rewardMode: "timed_draw",
    drawProgress: "waiting",
    poolAmount: "20.00",
    deadlineAt: prototypeDeadlineAt("draw"),
    count: 10,
    remaining: 10,
    passwords: ["开奖口令2026", "限时口令2026"],
  },
  {
    id: "thanks",
    title: "十月第一期红包",
    author: "木木",
    username: "mumu",
    color: "sand",
    type: "ldc",
    description: "本期活动已结束，领取记录可继续查看。",
    beforeInfo:
      "**十月第一期红包**\n\n本期为固定均分奖励，每个账号最多兑换一份。",
    afterClaimInfo:
      "感谢参与十月第一期红包。\n\n你的奖励记录已保留，可通过活动历史核对本次结果。",
    afterEndInfo:
      "十月第一期红包已经结束。\n\n[查看活动广场](#square)中的其他活动，已有奖励和记录继续保留。",
    amount: "0.50",
    rewardMode: "fixed",
    poolAmount: "15.00",
    deadlineAt: prototypeDeadlineAt("ldc", "ended"),
    count: 30,
    remaining: 0,
    passwords: ["十月口令2026", "历史口令2026"],
    ended: true,
  },
  {
    id: "notes-drawing-ended",
    title: "报名已结束 · 结果处理中",
    author: "阿山",
    username: "ashan",
    color: "blue",
    type: "draw",
    rewardMode: "timed_draw",
    poolAmount: "20.00",
    amount: "20.00",
    count: 10,
    remaining: 10,
    registrationCount: 30,
    deadlineAt: prototypeDeadlineAt("draw", "ended"),
    lifecycle: "ended",
    ended: true,
    drawProgress: "settling",
    passwords: ["阶段说明口令2026"],
    description: "用于体验报名已结束、开奖结果尚未发布的活动。",
    beforeInfo:
      "**结果处理中活动**\n\n报名只取得资格，结果发布前不能确认中奖或查看奖励附言。",
    afterClaimInfo:
      "结果处理中活动的奖励已经分配。\n\n只有确认获奖的本人能看到这段附言；当前样例尚未发布结果。",
    afterEndInfo:
      "本活动报名已经结束，正在开奖。\n\n结束说明已公开，中奖结果仍以活动后续发布为准。",
  },
];
export const longNote = [
  "本活动包含 LDC 奖励。输入有效口令后，可以领取一份奖励。",
  "请先阅读**活动规则**。每个账号只能领取一次，同一活动的多个口令共享奖励库存。",
  "参与步骤：\n\n- 查看活动期限\n- 输入有效口令\n- 查看领取结果",
  "问题反馈请访问[关联论坛回复](https://linux.do/t/2964597/1216)。",
  "活动结束后不能新增领取，已有领取记录和发放状态仍可查询。",
].join("\n\n");

export const forumLookupFixture = {
  topicId: "2964597",
  replyNumber: "1216",
  activityIds: ["weekend", "reading-ldc"],
};

export type RecipientExample = {
  id?: string;
  name: string;
  username: string;
  color: string;
  time: string;
  amount?: string;
};

function isoAt(offsetMs: number) {
  return new Date(prototypeStartedAt + offsetMs).toISOString();
}

const recipientProfiles = [
  ["南风", "nanfeng"],
  ["一只橘子", "orange"],
  ["慢慢来就好", "slowly"],
  ["听雨", "tingyu"],
  ["星河", "xinghe"],
  ["晚风", "wanfeng"],
  ["小鹿", "xiaolu"],
  ["竹影", "zhuying"],
  ["青柠", "qingning"],
  ["云朵", "yunduo"],
  ["白露", "bailu"],
  ["听风", "tingfeng"],
  ["小岛", "xiaodao"],
  ["山茶", "shancha"],
  ["春野", "chunye"],
  ["满月", "manyue"],
  ["山海", "shanhai"],
  ["松果", "songguo"],
  ["橙子", "chengzi"],
  ["墨白", "mobai"],
  ["江月", "jiangyue"],
  ["小禾", "xiaohe"],
  ["拾光", "shiguang"],
  ["芋圆", "yuyuan"],
  ["初夏", "chuxia"],
  ["柚子", "youzi"],
  ["秋水", "qiushui"],
  ["晨曦", "chenxi"],
  ["鹿鸣", "luming"],
  ["远山", "yuanshan"],
] as const;

const recipientColors = ["sage", "peach", "blue", "sand"] as const;

export const recipientExamples: RecipientExample[] = recipientProfiles.map(
  ([name, username], index) => ({
    id: `recipient-${String(index + 1).padStart(4, "0")}`,
    name,
    username,
    color: recipientColors[index % recipientColors.length] ?? "sage",
    time: isoAt(index === 0 ? -10_000 : -(index * 3 - 1) * 60_000),
  }),
);

const drawResultTime = isoAt(-90 * 60_000);

export const drawWinnerExamples: RecipientExample[] = [
  {
    name: "林间",
    username: "linjian",
    color: "sage",
    time: drawResultTime,
    amount: "2.18",
  },
  {
    name: "南风",
    username: "nanfeng",
    color: "sage",
    time: drawResultTime,
    amount: "8.82",
  },
  {
    name: "一只橘子",
    username: "orange",
    color: "peach",
    time: drawResultTime,
    amount: "9.00",
  },
];

export const drawOtherWinnerExamples: RecipientExample[] =
  drawWinnerExamples.map((winner) =>
    winner.username === "linjian"
      ? { ...winner, name: "慢慢来就好", username: "slowly", color: "blue" }
      : winner,
  );

export type RandomRosterCase = "unique" | "tie-two" | "tie-three" | "equal";

export const randomRosterCaseLabels: Record<RandomRosterCase, string> = {
  unique: "金额极值各 1 人",
  "tie-two": "金额极值各 2 人",
  "tie-three": "金额极值各 3 人",
  equal: "金额全部相同",
};

// Every published roster uses exactly 2,000 integer cents. The active pool also
// retains ten 100-cent shares; switching views never regenerates any amount.
const randomAmounts: Record<RandomRosterCase, readonly number[]> = {
  unique: [
    180, 20, 98, 145, 55, 127, 73, 162, 38, 119, 81, 151, 49, 134, 66, 172, 28,
    116, 84, 102,
  ],
  "tie-two": [180, 180, 20, 20, ...Array<number>(16).fill(100)],
  "tie-three": [180, 180, 180, 20, 20, 20, ...Array<number>(14).fill(100)],
  equal: Array<number>(20).fill(100),
};

function ldcAmount(cents: number) {
  return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`;
}

export const randomActivities: Activity[] = [
  {
    id: "random",
    title: "即时随机红包 · 30 份",
    author: "北岸",
    username: "north",
    color: "blue",
    type: "ldc",
    rewardMode: "instant_random",
    poolAmount: "30.00",
    deadlineAt: prototypeDeadlineAt("ldc"),
    amount: "",
    count: 30,
    remaining: 10,
    lifecycle: "active",
    description: "奖池 30.00 LDC，共 30 份。",
    beforeInfo:
      "**即时随机红包**\n\n每个账号可兑换一次，实际奖励金额以本人分配结果为准。",
    afterClaimInfo:
      "即时随机红包已兑换。\n\n本次金额已经固定，刷新或翻页不会重新分配奖励。",
    afterEndInfo:
      "本期即时随机红包已结束。\n\n完整公开名单中的金额与称号继续保留。",
    passwords: ["随机口令2026", "随机红包2026"],
  },
  {
    id: "random-ended",
    title: "即时随机红包 · 已结束",
    author: "北岸",
    username: "north",
    color: "blue",
    type: "ldc",
    rewardMode: "instant_random",
    poolAmount: "20.00",
    deadlineAt: prototypeDeadlineAt("ldc", "ended"),
    amount: "",
    count: 20,
    remaining: 0,
    lifecycle: "ended",
    ended: true,
    description: "奖池 20.00 LDC，20 份奖励已领取。",
    beforeInfo:
      "**即时随机历史红包**\n\n这场活动的奖励已经全部分配，可以查看允许公开的领取记录。",
    afterClaimInfo:
      "你的即时随机历史红包结果已保存。\n\n请通过活动历史核对本人的金额和发放确认信息。",
    afterEndInfo:
      "即时随机历史红包已结束。\n\n奖励金额保持固定，继续验证口令不会增加奖励。",
    passwords: ["随机历史2026", "历史红包2026"],
  },
];

type HistorySpecification = {
  id: string;
  title: string;
  type: Activity["type"];
  participation: Exclude<Participation, "none">;
  lifecycle: ActivityLifecycle;
  rewardMode?: RewardMode;
  amount?: string;
  payment?: PaymentProgress;
  rosterCase?: RandomRosterCase;
};

const historySpecifications: HistorySpecification[] = [
  {
    id: "history-fixed-active",
    title: "社区资料整理 · 固定红包",
    type: "ldc",
    rewardMode: "fixed",
    participation: "claimed",
    lifecycle: "active",
    amount: "0.30",
    payment: "confirmed",
  },
  {
    id: "history-random-active",
    title: "周六即时随机红包",
    type: "ldc",
    rewardMode: "instant_random",
    participation: "claimed",
    lifecycle: "active",
    payment: "confirmed",
  },
  {
    id: "history-fixed-reading",
    title: "命令速查表红包",
    type: "ldc",
    rewardMode: "fixed",
    amount: "0.50",
    participation: "claimed",
    lifecycle: "active",
  },
  {
    id: "history-draw-registered",
    title: "晚间限时开奖 · 已报名",
    type: "draw",
    participation: "registered",
    lifecycle: "active",
  },
  {
    id: "history-draw-settling",
    title: "周末限时开奖 · 开奖中",
    type: "draw",
    participation: "drawing",
    lifecycle: "ended",
  },
  {
    id: "history-draw-won",
    title: "开源工具活动 · 已中奖",
    type: "draw",
    participation: "won",
    lifecycle: "ended",
    payment: "confirmed",
  },
  {
    id: "history-draw-not-won",
    title: "社区分享会 · 未中奖",
    type: "draw",
    participation: "not-won",
    lifecycle: "ended",
  },
  {
    id: "history-fixed-pending",
    title: "十月固定红包",
    type: "ldc",
    rewardMode: "fixed",
    participation: "claimed",
    lifecycle: "active",
    amount: "0.20",
    payment: "pending",
  },
  {
    id: "history-random-ended",
    title: "第一期即时随机红包",
    type: "ldc",
    rewardMode: "instant_random",
    participation: "claimed",
    lifecycle: "ended",
    payment: "confirmed",
  },
  {
    id: "history-fixed-handbook-archived",
    title: "开发手册红包 · 已归档",
    type: "ldc",
    rewardMode: "fixed",
    amount: "0.50",
    participation: "claimed",
    lifecycle: "archived",
  },
  {
    id: "history-fixed-archived",
    title: "九月固定红包 · 已归档",
    type: "ldc",
    rewardMode: "fixed",
    participation: "claimed",
    lifecycle: "archived",
    amount: "0.50",
    payment: "confirmed",
  },
  {
    id: "history-random-waiting",
    title: "工具交流即时随机红包",
    type: "ldc",
    rewardMode: "instant_random",
    participation: "claimed",
    lifecycle: "active",
    payment: "waiting",
  },
  {
    id: "history-fixed-utility",
    title: "工具箱试用红包",
    type: "ldc",
    rewardMode: "fixed",
    amount: "0.50",
    participation: "claimed",
    lifecycle: "ended",
  },
  {
    id: "history-draw-won-pending",
    title: "阅读活动限时开奖",
    type: "draw",
    participation: "won",
    lifecycle: "ended",
    payment: "pending",
  },
  {
    id: "history-fixed-confirmed",
    title: "社区问题整理奖励",
    type: "ldc",
    rewardMode: "fixed",
    participation: "claimed",
    lifecycle: "ended",
    amount: "0.50",
    payment: "confirmed",
  },
  {
    id: "history-random-tie-two",
    title: "即时随机 · 两人并列样例",
    type: "ldc",
    rewardMode: "instant_random",
    participation: "claimed",
    lifecycle: "ended",
    payment: "confirmed",
    rosterCase: "tie-two",
  },
  {
    id: "history-fixed-design",
    title: "图标素材红包",
    type: "ldc",
    rewardMode: "fixed",
    amount: "0.50",
    participation: "claimed",
    lifecycle: "active",
  },
  {
    id: "history-fixed-sending",
    title: "工具发布红包",
    type: "ldc",
    rewardMode: "fixed",
    participation: "claimed",
    lifecycle: "active",
    amount: "0.75",
    payment: "sending",
  },
  {
    id: "history-random-tie-three",
    title: "即时随机 · 三人并列样例",
    type: "ldc",
    rewardMode: "instant_random",
    participation: "claimed",
    lifecycle: "ended",
    payment: "confirmed",
    rosterCase: "tie-three",
  },
  {
    id: "history-draw-archived",
    title: "八月限时开奖 · 已归档",
    type: "draw",
    participation: "won",
    lifecycle: "archived",
    payment: "confirmed",
  },
  {
    id: "history-fixed-material",
    title: "部署清单资料红包",
    type: "ldc",
    rewardMode: "fixed",
    amount: "0.50",
    participation: "claimed",
    lifecycle: "ended",
  },
  {
    id: "history-random-equal",
    title: "即时随机 · 金额相同样例",
    type: "ldc",
    rewardMode: "instant_random",
    participation: "claimed",
    lifecycle: "ended",
    payment: "confirmed",
    rosterCase: "equal",
  },
  {
    id: "history-fixed-reconciling",
    title: "十月资料奖励 · 核对中",
    type: "ldc",
    rewardMode: "fixed",
    participation: "claimed",
    lifecycle: "ended",
    amount: "0.40",
    payment: "reconciling",
  },
  {
    id: "history-fixed-handbook",
    title: "Linux 操作手册红包",
    type: "ldc",
    rewardMode: "fixed",
    amount: "0.50",
    participation: "claimed",
    lifecycle: "ended",
  },
];

export const historySamples: Activity[] = historySpecifications.map(
  (specification, index) => {
    const random = specification.rewardMode === "instant_random";
    const count =
      specification.type === "draw"
        ? 10
        : random && specification.lifecycle === "active"
          ? 30
          : 20;
    const remaining =
      specification.lifecycle === "active"
        ? random
          ? 10
          : specification.type === "draw"
            ? 10
            : 8
        : 0;
    const amount = random
      ? ""
      : specification.type === "draw"
        ? "20.00"
        : (specification.amount ?? "0.50");
    const poolAmount =
      specification.type === "draw"
        ? "20.00"
        : random
          ? ldcAmount(count * 100)
          : (fixedPoolAmount(amount, count) ?? undefined);
    const profile = recipientExamples[index % recipientExamples.length];
    return {
      id: specification.id,
      title: specification.title,
      author: profile?.name ?? "南风",
      username: profile?.username ?? "nanfeng",
      color: profile?.color ?? "sage",
      type: specification.type,
      rewardMode:
        specification.type === "draw" ? "timed_draw" : specification.rewardMode,
      poolAmount,
      deadlineAt: prototypeDeadlineAt(
        specification.type,
        specification.lifecycle,
      ),
      amount,
      count,
      remaining,
      lifecycle: specification.lifecycle,
      ...(specification.type === "draw"
        ? {
            drawProgress:
              specification.participation === "registered"
                ? ("waiting" as const)
                : specification.participation === "drawing"
                  ? ("settling" as const)
                  : ("completed" as const),
          }
        : {}),
      ended:
        specification.lifecycle === "ended" ||
        specification.lifecycle === "archived",
      description:
        random || specification.type === "draw"
          ? `奖池 ${poolAmount} LDC，共 ${count} ${specification.type === "draw" ? "个获奖名额" : "份奖励"}。`
          : `每份 ${amount} LDC，共 ${count} 份。`,
      beforeInfo: `**${specification.title}**\n\n${
        specification.type === "draw"
          ? "每个账号只能报名一次，报名后等待活动公布中奖结果。"
          : "每个账号可兑换一份 LDC 奖励，实际金额以本人记录为准。"
      }`,
      afterClaimInfo: `你已获得“${specification.title}”的奖励。\n\n${"本次分配结果已保存；付款确认状态另行显示，不影响查看这段附言。"}`,
      afterEndInfo: `“${specification.title}”已结束。\n\n${
        specification.participation === "drawing"
          ? "报名已经停止，中奖结果仍在处理中。此说明不代表开奖完成。"
          : "已有参与和奖励记录保留，可继续查看公开口令和允许公开的名单。"
      }`,
      passwords: [
        `历史口令${String(index + 1).padStart(2, "0")}`,
        `活动口令${String(index + 1).padStart(2, "0")}`,
      ],
    };
  },
);

const historyById = new Map(
  historySpecifications.map((entry) => [entry.id, entry]),
);
const sampleActivities = new Map(
  [...randomActivities, ...historySamples].map((entry) => [entry.id, entry]),
);

function sampleResult(activity: Activity, index: number): ParticipationResult {
  const specification = historyById.get(activity.id);
  const participation = specification?.participation ?? "claimed";
  const reward = participation === "claimed" || participation === "won";
  const rosterCase = specification?.rosterCase ?? "unique";
  const deadline = Date.parse(activity.deadlineAt ?? "");
  const participatedAt = Math.min(
    prototypeStartedAt - (index + 1) * 18 * 60000,
    Number.isFinite(deadline) ? deadline - 18 * 60000 : Infinity,
  );
  const payment = reward ? (specification?.payment ?? "confirmed") : null;
  return {
    participation,
    participatedAt: new Date(participatedAt).toISOString(),
    confirmedAt:
      payment === "confirmed"
        ? new Date(
            Math.max(
              participatedAt + 45_000,
              activity.type === "draw" && Number.isFinite(deadline)
                ? deadline + 15_000
                : participatedAt + 45_000,
            ),
          ).toISOString()
        : null,
    ...(reward
      ? {
          rewardAmount:
            activity.rewardMode === "instant_random"
              ? ldcAmount(randomAmounts[rosterCase][2] ?? 98)
              : activity.type === "draw"
                ? (drawWinnerExamples[0]?.amount ?? "2.18")
                : activity.amount,
        }
      : {}),
    password: activity.passwords[0],
    viewState: {
      lifecycle: activity.lifecycle ?? "active",
      participation,
      drawProgress:
        activity.type === "draw" ? (activity.drawProgress ?? "waiting") : null,
      paymentProgress: payment,
    },
  };
}

export const sampleResults: Record<string, ParticipationResult> =
  Object.fromEntries(
    [...randomActivities, ...historySamples].map((activity, index) => [
      activity.id,
      sampleResult(activity, index),
    ]),
  );

export function getSampleResult(
  activityId: string,
  rosterCase?: RandomRosterCase,
): ParticipationResult | undefined {
  const result = sampleResults[activityId];
  if (!result) return undefined;
  const activity = sampleActivities.get(activityId);
  return {
    ...result,
    viewState: { ...result.viewState },
    ...(rosterCase &&
    activity?.rewardMode === "instant_random" &&
    !historyById.has(activityId)
      ? { rewardAmount: ldcAmount(randomAmounts[rosterCase][2] ?? 98) }
      : {}),
  };
}

export function createParticipationSeed(identity: Identity) {
  const entries = historySamples
    .filter(() => identity === "standard")
    .map((activity) => [activity.id, getSampleResult(activity.id)] as const)
    .filter((entry): entry is readonly [string, ParticipationResult] =>
      Boolean(entry[1]),
    );
  return {
    records: Object.fromEntries(
      entries.map(([id, result]) => [id, result.participation]),
    ) as Record<string, Participation>,
    results: Object.fromEntries(entries) as Record<string, ParticipationResult>,
    viewStates: Object.fromEntries(
      entries.map(([id, result]) => [id, { ...result.viewState }]),
    ) as Record<string, ActivityViewStateOverrides>,
  };
}

/** Complete published rows, before the caller applies any display pagination. */
export function getSampleRecipients(
  activityId: string,
  rosterCase?: RandomRosterCase,
): RecipientExample[] | undefined {
  const activity = sampleActivities.get(activityId);
  if (!activity) return undefined;
  if (activity.type === "draw") {
    if (activity.drawProgress !== "completed") return [];
    return (
      historyById.get(activityId)?.participation === "won"
        ? drawWinnerExamples
        : drawOtherWinnerExamples
    ).map((entry) => ({ ...entry }));
  }
  const amounts =
    activity.rewardMode === "instant_random"
      ? randomAmounts[
          rosterCase && !historyById.has(activityId)
            ? rosterCase
            : (historyById.get(activityId)?.rosterCase ?? "unique")
        ]
      : undefined;
  const size = amounts?.length ?? activity.count - activity.remaining;
  return recipientExamples.slice(0, size).map((entry, index) => ({
    ...(index === 2
      ? {
          name: "林间",
          username: "linjian",
          color: "sage",
          time: getSampleResult(activityId)?.participatedAt ?? entry.time,
        }
      : entry),
    amount: amounts ? ldcAmount(amounts[index] ?? 100) : activity.amount,
  }));
}
