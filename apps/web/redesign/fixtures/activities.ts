// Local examples only. UUIDs are real so UUID / emoji / link recognition works;
// the old prototype's slug ids cannot be emoji-encoded.

export type RewardMode = "fixed" | "random" | "custom" | "timed_draw";

/** One claim, or one sign-up for a timed draw. */
export type EntrySeed = {
  name: string;
  /** Seconds after the 红包 opened. */
  at: number;
  /** The claimed amount; sign-ups have none. */
  amount?: string;
};

export type FixtureActivity = {
  id: string;
  title: string;
  /** What this example is for, shown in the dev toolbar (小类). */
  situation: string;
  author: { displayName: string; username: string };
  mode: RewardMode;
  participation: "password" | "direct";
  status: "active" | "ended";
  /** One-line reward rule, used by result lists. */
  rewardSummary: string;
  /** The pool; fixed split also has the amount per share. */
  totalAmount: string;
  unitAmount?: string;
  /** Shares offered; for a timed draw, the number of winners. */
  shares: number;
  /** Exact counts, or only a level (充足 / 有限 / 少量 / 已领完). */
  quantity: "exact" | "fuzzy";
  /** 自定义金额: one amount per share, paid in list order or at random. */
  custom?: { lines: string[]; allocation: "sequential" | "random" };
  /** A timed draw's 报名上限; null or absent = unlimited. */
  participantLimit?: number | null;
  /** Minutes before page load it opened; "first-view" opens when first shown. */
  opened: number | "first-view";
  /** Minutes from page load until the deadline (negative = already passed). */
  deadlineMinutes: number;
  /** A fixed clock time instead (指定时间): days from today, hour, minute. */
  deadlineClock?: { day: number; hour: number; minute: number };
  /** Claims, or sign-ups for a timed draw, oldest first. */
  entries: EntrySeed[];
  /** A timed draw's results: winners by entry index (best prize first). */
  draw?: { winners: { entry: number | "me"; amount: string }[] };
  /**
   * The demo viewer (林间) took part before the page loaded. Signed in, it
   * is their own record (an ended 红包 they claimed); to anyone else, just
   * another row. "me" in draw.winners is this entry.
   */
  mine?: {
    kind: "claimed" | "registered";
    /** Seconds after the 红包 opened. */
    at: number;
    password: string | null;
    amount?: string;
  };
  /** 活动说明 (public), 奖励附言 (claimer only), 结束说明 (public once ended). */
  beforeInfo?: string;
  afterClaimInfo?: string;
  afterEndInfo?: string;
  passwords: string[];
  topic?: { topicId: string; postNumber: number };
  /** What the next claim pays, given how many shares are already taken. */
  amount: (taken: number) => string;
  /** 加入广场: listed on /square (default yes). */
  listed?: boolean;
  /** Saved but not opened yet (草稿): only its sender sees it. */
  draft?: boolean;
  /** 口令尝试统计: passwords only on the 红包 page, attempts recorded (📊). */
  statistics?: boolean;
  /** 提前结束 by its sender, at this time (prototype only, from 📝). */
  closedAt?: number;
  /** 拼手气 / 限时开奖: how the pool is split (default 二倍均值). */
  algorithm?: "double_mean" | "bounded_mean";
  /** 限时开奖: 人数不足时发完奖池 (default on). */
  fillPool?: boolean;
  /**
   * A 草稿's deadline as the sender set it: a duration counted from the
   * moment it opens, or a fixed time. Opening turns it into the deadline.
   */
  draftTiming?: {
    kind: "duration" | "at";
    value: string;
    unit: "minutes" | "hours" | "days";
    at: string;
  };
};

const names = [
  "阿青",
  "小鹿",
  "南风",
  "橘子汽水",
  "老周",
  "Kiki",
  "晴天",
  "阿北",
  "七七",
  "山茶",
  "林间月",
  "一只猫",
  "白开水",
  "秋刀鱼",
  "阿土",
  "莫莫",
  "拾光",
  "大橙子",
  "星河",
  "半夏",
];

/** Entries at the given seconds after opening, names taken in turn. */
function seed(offset: number, seconds: number[], amounts?: string[]) {
  return seconds.map((at, index) => ({
    name: names[(offset + index) % names.length] ?? "匿名",
    at,
    amount: amounts?.[index],
  }));
}

const fixedAmount = (value: string) => () => value;
/** 自定义 · 按顺序: the next claim takes the next line of the list. */
const inOrder = (lines: string[]) => (taken: number) =>
  lines[taken] ?? lines.at(-1) ?? "0.00";
/** Each claim takes the next value, so title changes can be shown live. */
const cycle = (values: string[]) => {
  let next = 0;
  return () => values[next++ % values.length] ?? "0.00";
};

// 答题奖励: paid in list order, the earliest answers get the most.
const quizLines = [
  "8.88",
  "6.66",
  "5.20",
  "3.33",
  "2.22",
  "1.11",
  "1.11",
  "1.11",
  "1.11",
  "1.11",
];

// 十月第一期: 30 claims, the first two in the same instant.
const octoberSeconds = [
  2.4, 2.4, 6, 11, 19, 30, 45, 63, 90, 120, 160, 210, 270, 340, 420, 510, 620,
  750, 900, 1080, 1290, 1530, 1800, 2100, 2450, 2850, 3300, 3800, 4400, 5100,
];

export const activities: FixtureActivity[] = [
  {
    id: "067e037a-d3f8-4a2d-b3fb-d6523b6684f5",
    title: "周末红包 · 20 份",
    situation: "进行中 · 口令",
    author: { displayName: "小满", username: "xiaoman" },
    mode: "fixed",
    participation: "password",
    status: "active",
    rewardSummary: "固定均分 · 0.88 LDC / 份",
    totalAmount: "17.60",
    unitAmount: "0.88",
    shares: 20,
    quantity: "exact",
    opened: 52,
    deadlineMinutes: 138,
    entries: seed(
      0,
      [4.6, 31.2, 75, 140, 610, 1300, 2100, 2900],
      Array(8).fill("0.88"),
    ),
    beforeInfo: "周末快乐！口令藏在帖子一楼的最后一句话里。",
    afterClaimInfo: "谢谢捧场，祝周末愉快！",
    passwords: ["周末口令2026", "公共口令2026"],
    topic: { topicId: "2964597", postNumber: 1 },
    amount: fixedAmount("0.88"),
  },
  {
    id: "ed1a16cb-8afc-4e30-98e2-0d2256f1ecc7",
    title: "新版本发布纪念",
    situation: "进行中 · 无需口令",
    author: { displayName: "十一", username: "shiyi" },
    mode: "fixed",
    participation: "direct",
    status: "active",
    rewardSummary: "固定均分 · 0.10 LDC / 份",
    totalAmount: "2.00",
    unitAmount: "0.10",
    shares: 20,
    quantity: "exact",
    opened: 300,
    deadlineMinutes: 1440,
    entries: seed(
      2,
      [34.2, 80, 200, 500, 1200, 3000, 8000, 15000],
      Array(8).fill("0.10"),
    ),
    beforeInfo: "感谢大家一起测试新版本，打开就能领。",
    passwords: [],
    amount: fixedAmount("0.10"),
  },
  {
    id: "9093a1a9-3455-46c2-bb50-d0c75635c4f6",
    title: "电子书阅读红包",
    situation: "进行中 · 模糊数量",
    author: { displayName: "白桃", username: "whitepeach" },
    mode: "fixed",
    participation: "password",
    status: "active",
    rewardSummary: "固定均分 · 0.50 LDC / 份",
    totalAmount: "6.00",
    unitAmount: "0.50",
    shares: 12,
    quantity: "fuzzy",
    opened: 200,
    deadlineMinutes: 520,
    entries: seed(
      4,
      [40, 300, 900, 2000, 4000, 7000, 11000],
      Array(7).fill("0.50"),
    ),
    beforeInfo: "读完这个月书单的朋友来领，口令在书单帖子里。",
    passwords: ["阅读口令2026", "公共口令2026"],
    topic: { topicId: "2964597", postNumber: 1 },
    amount: fixedAmount("0.50"),
  },
  {
    id: "f528cba8-adc7-4e37-a92e-7f778b107e75",
    title: "十月第一期红包",
    situation: "已领完",
    author: { displayName: "木木", username: "mumu" },
    mode: "fixed",
    participation: "password",
    status: "ended",
    rewardSummary: "固定均分 · 0.50 LDC / 份",
    totalAmount: "15.00",
    unitAmount: "0.50",
    shares: 30,
    quantity: "exact",
    opened: 4400,
    deadlineMinutes: -2880,
    entries: seed(9, octoberSeconds, Array(30).fill("0.50")),
    beforeInfo: "十月第一期，口令在月初的帖子里。",
    afterEndInfo: "十月第一期已经领完，下期见！",
    passwords: ["十月口令2026", "国庆快乐2026", "秋天口令2026"],
    amount: fixedAmount("0.50"),
  },
  {
    id: "6e2c8b4a-9d1f-4a73-8c5e-3b7d1f0a9e26",
    title: "中秋红包",
    situation: "已结束 · 你领过",
    author: { displayName: "阿北", username: "abei" },
    mode: "fixed",
    participation: "password",
    status: "ended",
    rewardSummary: "固定均分 · 0.66 LDC / 份",
    totalAmount: "10.56",
    unitAmount: "0.66",
    shares: 16,
    quantity: "exact",
    opened: 4320,
    deadlineMinutes: -1440,
    entries: seed(
      1,
      [
        9.1, 15, 22, 31, 48, 75, 120, 190, 300, 460, 700, 1100, 1700, 2600,
        3900,
      ],
      Array(15).fill("0.66"),
    ),
    mine: {
      kind: "claimed",
      at: 7.2,
      password: "中秋口令2026",
      amount: "0.66",
    },
    beforeInfo: "中秋快乐！口令是“中秋口令”加上今年的年份。",
    afterClaimInfo: "中秋快乐，月圆人团圆！",
    afterEndInfo: "中秋红包已经领完，明年见。",
    passwords: ["中秋口令2026", "月饼口令2026"],
    amount: fixedAmount("0.66"),
  },
  {
    id: "0913fcad-8e09-4108-837c-f590410611da",
    title: "即时随机红包 · 30 份",
    situation: "进行中 · 口令",
    author: { displayName: "北岸", username: "beian" },
    mode: "random",
    participation: "password",
    status: "active",
    rewardSummary: "拼手气 · 30.00 LDC 奖池",
    totalAmount: "30.00",
    shares: 30,
    quantity: "exact",
    opened: 90,
    deadlineMinutes: 64,
    entries: seed(
      13,
      [
        12.3, 25, 41, 66, 98, 140, 190, 260, 340, 430, 560, 720, 900, 1150,
        1500, 1900, 2500, 3300, 4600,
      ],
      [
        "1.45",
        "2.18",
        "0.31",
        "0.88",
        "1.02",
        "2.18",
        "0.31",
        "1.67",
        "1.29",
        "0.31",
        "0.95",
        "1.73",
        "0.56",
        "1.11",
        "1.38",
        "0.74",
        "1.96",
        "0.62",
        "1.12",
      ],
    ),
    beforeInfo: "金额随机，拼手气。",
    passwords: ["随机口令2026", "网络中断测试"],
    // Top, bottom, then middle: the 手气王 / 手气亡 titles move live.
    amount: cycle(["2.36", "0.18", "1.07"]),
  },
  {
    id: "b7e3c1d2-4f5a-4e6b-9c7d-8e9f0a1b2c3d",
    title: "开门红 · 10 份",
    situation: "刚开放 · 无需口令",
    author: { displayName: "阿青", username: "aqing" },
    mode: "random",
    participation: "direct",
    status: "active",
    rewardSummary: "拼手气 · 6.66 LDC 奖池",
    totalAmount: "6.66",
    shares: 10,
    quantity: "exact",
    opened: "first-view",
    deadlineMinutes: 120,
    entries: [],
    // No 说明 and no 口令: the shortest page once claimed.
    passwords: [],
    amount: cycle(["0.66", "1.08", "0.42"]),
  },
  {
    id: "e4d2a8f6-1b9c-4e37-a5d0-6c8f2b1e9d74",
    title: "假期红包",
    situation: "已过期",
    author: { displayName: "半夏", username: "banxia" },
    mode: "random",
    participation: "password",
    status: "ended",
    rewardSummary: "拼手气 · 20.00 LDC 奖池",
    totalAmount: "20.00",
    shares: 20,
    quantity: "exact",
    opened: 2160,
    deadlineMinutes: -720,
    entries: seed(
      6,
      [7.5, 19, 44, 90, 180, 400, 900, 1700, 3200, 6000, 12000, 30000],
      [
        "1.62",
        "0.47",
        "2.31",
        "0.88",
        "1.15",
        "0.39",
        "1.94",
        "0.73",
        "1.28",
        "0.56",
        "2.05",
        "0.62",
      ],
    ),
    beforeInfo: "假期快乐！口令是帖子标题的后半句。",
    afterEndInfo: "假期红包已过期，没领完的部分已退回。",
    passwords: ["假期口令2026", "放假快乐2026"],
    amount: fixedAmount("0.00"),
  },
  {
    id: "3c9e5a71-2b4d-4f86-a1c3-7d2e9b8f6a40",
    title: "答题奖励 · 自定义",
    situation: "进行中 · 按顺序 · 口令",
    author: { displayName: "南风", username: "nanfeng" },
    mode: "custom",
    participation: "password",
    status: "active",
    rewardSummary: "自定义金额 · 31.84 LDC 奖池",
    totalAmount: "31.84",
    shares: 10,
    quantity: "exact",
    custom: { lines: quizLines, allocation: "sequential" },
    opened: 40,
    deadlineMinutes: 300,
    entries: seed(3, [9.8, 47, 130, 600], quizLines.slice(0, 4)),
    beforeInfo: "答对题目的朋友按顺序领，越早金额越大。",
    afterClaimInfo: "答对了！奖励按领取顺序发放。",
    passwords: ["答题口令2026"],
    amount: inOrder(quizLines),
  },
  {
    id: "5f1d8c2a-7e3b-4a96-b2d4-0c6e1f9a8b37",
    // A long title and a long 说明: the big cover's 展开全文, the small
    // cover's one-line title.
    title: "周年庆 · 自定义 · 感谢一年来每一位朋友的陪伴",
    situation: "进行中 · 随机 · 无需口令 · 模糊 · 长说明",
    author: { displayName: "星河", username: "xinghe" },
    mode: "custom",
    participation: "direct",
    status: "active",
    rewardSummary: "自定义金额 · 14.50 LDC 奖池",
    totalAmount: "14.50",
    shares: 8,
    quantity: "fuzzy",
    custom: {
      lines: ["5.00", "3.00", "2.00", "1.50", "1.00", "1.00", "0.50", "0.50"],
      allocation: "random",
    },
    opened: 600,
    deadlineMinutes: 2880,
    entries: seed(
      11,
      [21, 95, 300, 1200, 4000, 9000, 20000],
      ["1.00", "5.00", "0.50", "2.00", "1.00", "3.00", "0.50"],
    ),
    beforeInfo: [
      "感谢一年来的陪伴！这个红包无需口令，打开就能领，金额从清单里随机抽，最大的一份 5 LDC。一共 8 份，领完即止，每人限领一次。",
      "去年这个时候我们只有十几个人，现在每天都有新朋友在帖子里分享自己做的表情包。谢谢每一位愿意花时间认真回复、帮新人答疑的朋友，也谢谢大家对小站的包容和建议。",
      "周年活动的完整说明和后续安排都在这里：https://linux.do/t/topic/3001234 ，有问题欢迎在帖子里留言，我会一一回复。",
    ].join("\n\n"),
    afterClaimInfo: "周年快乐！",
    passwords: [],
    // The one line nobody has drawn yet.
    amount: fixedAmount("1.50"),
  },
  {
    id: "a419cb0c-2170-48ba-9520-af4acf91f853",
    title: "十分钟限时开奖",
    situation: "报名中 · 口令 · 不限人数",
    author: { displayName: "阿山", username: "ashan" },
    mode: "timed_draw",
    participation: "password",
    status: "active",
    rewardSummary: "限时开奖 · 20.00 LDC 奖池",
    totalAmount: "20.00",
    shares: 10,
    quantity: "exact",
    opened: 60,
    deadlineMinutes: 9,
    entries: seed(
      7,
      [
        3, 8, 15, 22, 40, 60, 95, 130, 180, 240, 300, 420, 600, 800, 1000, 1300,
        1600, 1900, 2200, 2600, 3000, 3300, 3500,
      ],
    ),
    draw: {
      winners: [
        { entry: 0, amount: "3.12" },
        { entry: 3, amount: "2.64" },
        { entry: 5, amount: "2.41" },
        { entry: 8, amount: "2.20" },
        { entry: 11, amount: "1.98" },
        { entry: 13, amount: "1.85" },
        { entry: 16, amount: "1.66" },
        { entry: 18, amount: "1.50" },
        { entry: 20, amount: "1.32" },
        { entry: 22, amount: "1.32" },
      ],
    },
    beforeInfo: "截止后从报名的人里随机抽 10 位，奖池 20 LDC 按手气分。",
    afterClaimInfo: "恭喜中奖！奖励会在开奖后一小时内发放。",
    afterEndInfo: "已开奖，感谢大家参与，下周同一时间再来。",
    passwords: ["开奖口令2026", "公共口令2026"],
    topic: { topicId: "3001234", postNumber: 5 },
    amount: fixedAmount("2.00"),
  },
  {
    id: "8a2f6d14-c3e7-4b5a-9d81-2f4c6e0b7a95",
    title: "周五抽奖",
    situation: "报名中 · 无需口令 · 有上限",
    author: { displayName: "老周", username: "laozhou" },
    mode: "timed_draw",
    participation: "direct",
    status: "active",
    rewardSummary: "限时开奖 · 10.00 LDC 奖池",
    totalAmount: "10.00",
    shares: 5,
    quantity: "exact",
    participantLimit: 30,
    opened: 180,
    deadlineMinutes: 1440,
    deadlineClock: { day: 1, hour: 20, minute: 0 },
    entries: seed(
      5,
      [
        6, 14, 30, 52, 90, 160, 240, 400, 620, 900, 1300, 1800, 2400, 3300,
        4500, 6000, 8000, 10500,
      ],
    ),
    draw: {
      winners: [
        { entry: 2, amount: "3.20" },
        { entry: 7, amount: "2.40" },
        { entry: 11, amount: "1.90" },
        { entry: 14, amount: "1.40" },
        { entry: 16, amount: "1.10" },
      ],
    },
    beforeInfo: "无需口令，点报名就行；明晚八点抽 5 位。",
    afterClaimInfo: "恭喜中奖！",
    afterEndInfo: "周五抽奖已开奖，下周见。",
    passwords: [],
    amount: fixedAmount("2.00"),
  },
  {
    id: "c7b3e9a2-5d1f-4c68-8e2a-9b4d7f1c3e60",
    title: "神秘抽奖",
    listed: false,
    situation: "报名中 · 名额不公开",
    author: { displayName: "莫莫", username: "momo" },
    mode: "timed_draw",
    participation: "password",
    status: "active",
    rewardSummary: "限时开奖 · 16.00 LDC 奖池",
    totalAmount: "16.00",
    shares: 8,
    quantity: "fuzzy",
    opened: 75,
    deadlineMinutes: 45,
    entries: seed(
      15,
      [11, 26, 48, 80, 130, 210, 330, 520, 800, 1200, 1900, 2700],
    ),
    draw: {
      winners: [
        { entry: 4, amount: "3.60" },
        { entry: 0, amount: "2.80" },
        { entry: 9, amount: "2.40" },
        { entry: 2, amount: "2.00" },
        { entry: 6, amount: "1.80" },
        { entry: 11, amount: "1.40" },
        { entry: 7, amount: "1.10" },
        { entry: 1, amount: "0.90" },
      ],
    },
    beforeInfo: "名额和人数都不公开，开奖见分晓。",
    afterClaimInfo: "恭喜中奖！",
    afterEndInfo: "神秘抽奖已开奖。",
    passwords: ["神秘口令2026"],
    amount: fixedAmount("2.00"),
  },
  {
    id: "3f7a9c2e-6b1d-4e84-a2c6-8d5b0e3f7a19",
    title: "满员抽奖",
    situation: "报名已满 · 开奖中",
    author: { displayName: "Kiki", username: "kiki" },
    mode: "timed_draw",
    participation: "direct",
    status: "active",
    rewardSummary: "限时开奖 · 8.00 LDC 奖池",
    totalAmount: "8.00",
    shares: 4,
    quantity: "exact",
    participantLimit: 12,
    opened: 30,
    deadlineMinutes: 90,
    entries: seed(10, [4, 9, 15, 23, 34, 50, 72, 110, 170, 260, 420, 700]),
    draw: {
      winners: [
        { entry: 2, amount: "2.80" },
        { entry: 7, amount: "2.10" },
        { entry: 0, amount: "1.70" },
        { entry: 10, amount: "1.40" },
      ],
    },
    beforeInfo: "名额 12 人，报满就开奖。",
    afterClaimInfo: "恭喜中奖！",
    afterEndInfo: "满员抽奖已开奖。",
    passwords: [],
    amount: fixedAmount("2.00"),
  },
  {
    id: "9b4e1c7d-2a6f-4e58-b3d9-7c0a5e8f1b42",
    title: "上周抽奖",
    situation: "已开奖 · 你中奖",
    author: { displayName: "七七", username: "qiqi" },
    mode: "timed_draw",
    participation: "direct",
    status: "ended",
    rewardSummary: "限时开奖 · 6.00 LDC 奖池",
    totalAmount: "6.00",
    shares: 3,
    quantity: "exact",
    opened: 10080,
    deadlineMinutes: -8640,
    entries: seed(8, [12, 30, 75, 160, 420, 900, 1800, 3600, 7200]),
    mine: { kind: "registered", at: 40, password: null },
    draw: {
      winners: [
        { entry: "me", amount: "2.88" },
        { entry: 3, amount: "1.86" },
        { entry: 6, amount: "1.26" },
      ],
    },
    beforeInfo: "无需口令，报名就能参加，抽 3 位。",
    afterClaimInfo: "恭喜中奖，奖励已经发放。",
    afterEndInfo: "上周抽奖已开奖，感谢参与。",
    passwords: [],
    amount: fixedAmount("2.00"),
  },
  {
    id: "a8d3f1b6-4c2e-4f97-9b1a-5e7c3d2f8a60",
    title: "月度抽奖",
    listed: false,
    situation: "已开奖 · 你未中",
    author: { displayName: "山茶", username: "shancha" },
    mode: "timed_draw",
    participation: "password",
    status: "ended",
    rewardSummary: "限时开奖 · 12.00 LDC 奖池",
    totalAmount: "12.00",
    shares: 4,
    quantity: "exact",
    opened: 20160,
    deadlineMinutes: -10080,
    entries: seed(
      12,
      [6, 18, 33, 60, 140, 260, 480, 900, 1500, 2600, 4200, 7000, 11000, 16000],
    ),
    mine: { kind: "registered", at: 95, password: "月度口令2026" },
    draw: {
      winners: [
        { entry: 1, amount: "4.20" },
        { entry: 5, amount: "3.30" },
        { entry: 9, amount: "2.60" },
        { entry: 12, amount: "1.90" },
      ],
    },
    beforeInfo: "每月一次，报名口令在月初的帖子里。",
    afterClaimInfo: "恭喜中奖！",
    afterEndInfo: "月度抽奖已开奖，没中的朋友下月再来。",
    passwords: ["月度口令2026"],
    amount: fixedAmount("3.00"),
  },
  {
    id: "2d6b9f3e-8a4c-4d15-b7e9-0f3a5c8d2b61",
    title: "冷门抽奖",
    situation: "无人报名",
    author: { displayName: "拾光", username: "shiguang" },
    mode: "timed_draw",
    participation: "direct",
    status: "ended",
    rewardSummary: "限时开奖 · 3.00 LDC 奖池",
    totalAmount: "3.00",
    shares: 3,
    quantity: "exact",
    opened: 1500,
    deadlineMinutes: -60,
    entries: [],
    beforeInfo: "三个名额，报名就有机会。",
    afterEndInfo: "无人报名，奖池已退回。",
    passwords: [],
    amount: fixedAmount("1.00"),
  },
  // 林间 (the demo account) sent these: 红包记录 · 我发的, and the sender's
  // pages under /🧧/<code>/ (📝 编辑, 📊 尝试统计, 🧾 付款).
  {
    id: "c2b7f1a4-5d3e-4f6a-9b8c-1d2e3f4a5b6c",
    title: "读书会 · 十月书单",
    situation: "我发的 · 进行中",
    author: { displayName: "林间", username: "linjian" },
    mode: "fixed",
    participation: "password",
    status: "active",
    rewardSummary: "固定均分 · 1.00 LDC / 份",
    totalAmount: "10.00",
    unitAmount: "1.00",
    shares: 10,
    quantity: "exact",
    opened: 300,
    deadlineMinutes: 2580,
    entries: seed(3, [12.8, 96, 1240], ["1.00", "1.00", "1.00"]),
    beforeInfo: "读完十月书单的朋友来领，口令是书单第三本书的书名。",
    afterClaimInfo: "下个月见！",
    passwords: ["十月书单2026"],
    statistics: true,
    topic: { topicId: "3012345", postNumber: 1 },
    amount: fixedAmount("1.00"),
  },
  {
    id: "c5d8e2a1-7b4c-4d9e-8f1a-2b3c4d5e6f7a",
    title: "下周抽奖",
    situation: "我发的 · 草稿",
    author: { displayName: "林间", username: "linjian" },
    mode: "timed_draw",
    participation: "password",
    status: "active",
    draft: true,
    listed: false,
    draftTiming: { kind: "duration", value: "7", unit: "days", at: "" },
    rewardSummary: "限时开奖 · 5.00 LDC 奖池",
    totalAmount: "5.00",
    shares: 5,
    quantity: "exact",
    participantLimit: null,
    opened: 0,
    deadlineMinutes: 10080,
    entries: [],
    beforeInfo: "下周五晚八点开奖，抽 5 位。",
    passwords: ["下周抽奖2026"],
    amount: fixedAmount("1.00"),
  },
  {
    id: "c9e1f3b5-2a4d-4c6e-8a0b-3c4d5e6f7a8b",
    title: "国庆加班红包",
    situation: "我发的 · 已领完",
    author: { displayName: "林间", username: "linjian" },
    mode: "random",
    participation: "direct",
    status: "ended",
    listed: false,
    rewardSummary: "拼手气 · 8.00 LDC 奖池",
    totalAmount: "8.00",
    shares: 8,
    quantity: "exact",
    opened: 20160,
    deadlineMinutes: -18720,
    entries: seed(
      5,
      [3.1, 3.9, 8, 15, 22, 40, 61, 90],
      ["1.36", "0.52", "2.10", "0.88", "0.64", "1.20", "0.30", "1.00"],
    ),
    beforeInfo: "国庆值班辛苦了，打开就能领。",
    afterEndInfo: "国庆加班红包已领完，大家辛苦了。",
    passwords: [],
    amount: cycle(["1.00"]),
  },
];

const byId = new Map(activities.map((activity) => [activity.id, activity]));

/** The dev toolbar's groups (大类), in this order; 小类 is `situation`. */
export const fixtureCategories: { mode: RewardMode; label: string }[] = [
  { mode: "fixed", label: "固定均分" },
  { mode: "random", label: "拼手气" },
  { mode: "custom", label: "自定义金额" },
  { mode: "timed_draw", label: "限时开奖" },
];

/** Examples the prototype's sample inputs and seeds refer to by name. */
export const fixtureIds = {
  weekend: "067e037a-d3f8-4a2d-b3fb-d6523b6684f5",
  reading: "9093a1a9-3455-46c2-bb50-d0c75635c4f6",
  draw: "a419cb0c-2170-48ba-9520-af4acf91f853",
  october: "f528cba8-adc7-4e37-a92e-7f778b107e75",
  random: "0913fcad-8e09-4108-837c-f590410611da",
  first: "b7e3c1d2-4f5a-4e6b-9c7d-8e9f0a1b2c3d",
} as const;

export function findActivity(id: string) {
  return byId.get(id.toLowerCase()) ?? null;
}

/**
 * A 红包 as this viewer may see it: a 草稿 exists only for its sender, so
 * to anyone else (title, address, page) it is not found.
 */
export function visibleActivity(
  id: string,
  username: string | null | undefined,
) {
  const activity = findActivity(id);
  if (!activity) return null;
  return activity.draft && activity.author.username !== username
    ? null
    : activity;
}

/** A 红包 made or changed in the prototype (发红包, 📝 编辑). */
export function registerActivity(activity: FixtureActivity) {
  byId.set(activity.id.toLowerCase(), activity);
}

export function unregisterActivity(id: string) {
  byId.delete(id.toLowerCase());
}

/** The samples' clock: deadlines and openings count from here. */
export let pageLoadedAt = Date.now();

/**
 * Re-anchors the samples to now. The dev server's image route keeps this
 * module loaded for as long as it runs, so without this every 红包 there
 * would end hours early; the browser anchors once per page load.
 */
export function anchorSamples(at = Date.now()) {
  pageLoadedAt = at;
  firstViews.clear();
}

export function deadlineOf(activity: FixtureActivity) {
  const clock = activity.deadlineClock;
  if (!clock) return pageLoadedAt + activity.deadlineMinutes * 60_000;
  const date = new Date(pageLoadedAt);
  date.setDate(date.getDate() + clock.day);
  date.setHours(clock.hour, clock.minute, 0, 0);
  return date.getTime();
}

/** The demo accounts' earlier claims, keyed by 红包 (see FixtureActivity.mine). */
export function seededClaims() {
  return Object.fromEntries(
    activities.flatMap((activity) =>
      activity.mine
        ? [
            [
              activity.id,
              {
                kind: activity.mine.kind,
                amount: activity.mine.amount,
                password: activity.mine.password,
                at: openedAtOf(activity) + activity.mine.at * 1000,
              },
            ],
          ]
        : [],
    ),
  );
}

const firstViews = new Map<string, number>();

/** When the 红包 opened; a "first-view" one opens the first time it is shown. */
export function openedAtOf(activity: FixtureActivity) {
  if (activity.opened !== "first-view")
    return pageLoadedAt - activity.opened * 60_000;
  const known = firstViews.get(activity.id);
  if (known !== undefined) return known;
  const now = Date.now();
  firstViews.set(activity.id, now);
  return now;
}
