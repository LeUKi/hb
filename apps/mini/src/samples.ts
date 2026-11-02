// 验证包 (docs/mini-app-design.md §5): sample 红包 in the package itself, so
// the sandbox shows the site's look and motion with no network. Nothing here
// is claimed for real.

export type SampleKind = "direct" | "password" | "code" | "human";

export type Sample = {
  kind: SampleKind;
  title: string;
  author: string;
  note: string;
  tags: string[];
  /** 奖池 and what is left, in LDC. */
  pool: string;
  left: string;
  /** 已领 x / y 份; none for 代码判定 (奖池还剩 instead). */
  shares?: { taken: number; total: number };
  /** What opening it gives, as "3.28". */
  amount: string;
  /** 口令: what opens it. */
  password?: string;
  /** Why it cannot be taken here: the forum's frame has no way to it. */
  elsewhere?: string;
};

export const samples: Record<SampleKind, Sample> = {
  direct: {
    kind: "direct",
    title: "论坛小程序试玩红包",
    author: "lafish",
    note: "第一次在论坛里直接开红包，点下面的「开」试试。",
    tags: ["无需口令", "拼手气"],
    pool: "100.00",
    left: "71.24",
    shares: { taken: 3, total: 10 },
    amount: "3.28",
  },
  password: {
    kind: "password",
    title: "暗号红包",
    author: "lafish",
    note: "暗号是「你好论坛」。",
    tags: ["口令红包", "拼手气"],
    pool: "20.00",
    left: "18.34",
    shares: { taken: 1, total: 8 },
    amount: "1.66",
    password: "你好论坛",
  },
  code: {
    kind: "code",
    title: "矿洞夺宝 · 多人试玩",
    author: "lafish",
    note: "大家共享一张矿洞卡，点格子挖宝。",
    tags: ["代码判定"],
    pool: "100.00",
    left: "86.50",
    amount: "0.00",
    elsewhere: "这个红包带附带网页（矿洞夺宝），要在红包站里玩。",
  },
  human: {
    kind: "human",
    title: "需要人机验证的红包",
    author: "lafish",
    note: "红包作者要求领取前先通过人机验证。",
    tags: ["无需口令", "固定均分", "需人机验证"],
    pool: "50.00",
    left: "40.00",
    shares: { taken: 2, total: 10 },
    amount: "5.00",
    elsewhere:
      "这个红包要先通过人机验证，论坛小程序里加载不了验证，请到红包站领取。",
  },
};
