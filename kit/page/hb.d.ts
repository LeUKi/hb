// 红包站附带网页 SDK v1 的类型：网页里引用
// <script src="https://hb.lafi.sh/sdk/v1.js"></script> 以后的全局 hb。
// 说明见 https://hb.lafi.sh/help/page#sdk 和开发包的 AGENTS.md“附带网页”。

/** 红包的公开信息。 */
export interface HbHongbao {
  id: string;
  title: string;
  /** 红包页的地址 */
  url: string;
  /** 是不是代码判定红包（只有它能提交） */
  code: boolean;
  /** draft 未开放，active 进行中，ended 已结束 */
  status: "draft" | "active" | "ended";
  /** 判定器用 end 结束了它 */
  endedByCode: boolean;
  unit: "LDC" | "🐟";
  /** 红包没公开份数时是 null */
  shares: { total: number; claimed: number; remaining: number } | null;
  /** 奖池总额，比如 "10.00"；没有时 null */
  pool: string | null;
  deadlineAt: string | null;
  /** 已判定几次 */
  judged: number | null;
}

/** 看的人：登录了只给昵称，不给编号。 */
export type HbViewer = { signedIn: true; name: string } | { signedIn: false };

/** 判定器写的公开数据（判定结果的 view）。 */
export interface HbView {
  summary: string | null;
  data: unknown;
  /** 什么时候写的 */
  at: string;
}

/** 一条动态。 */
export interface HbAnnouncement {
  /** 第几条，从 0 起 */
  n: number;
  at: string;
  user: { name: string; avatar: string | null };
  text: string;
}

/** 没判定的原因。 */
export type HbReason =
  /** 看的人没允许网页替他提交（领自己的红包时点了返回也是） */
  | "denied"
  /** 没登录：红包页弹出了登录卡片，登录回来以后网页再提交 */
  | "login"
  /** 冷却中，seconds 是还剩几秒 */
  | "cooldown"
  /** 上一次提交还没有结果 */
  | "busy"
  /** 没完成或没通过人机验证 */
  | "human_check"
  /** 不在领取范围 */
  | "not_in_scope"
  /** 已经领到过（每人领一次） */
  | "already_claimed"
  /** 还没开放 */
  | "not_open"
  /** 红包已结束 */
  | "ended"
  /** 代码连续出错，暂停领取 */
  | "paused"
  /** 这次代码出错了，不算次数 */
  | "judge_failed"
  /** 提交的人太多、太频繁，或判定暂时不可用 */
  | "try_later"
  /** 输入不合规则（空、超过 200 字、有换行），message 是原因 */
  | "invalid_input"
  /** 没收到回应，可能已经提交了，用 hb.mine() 看 */
  | "unconfirmed"
  /** 看的人不在这个红包页上（网页还开着，但没在显示） */
  | "away"
  /** 不是代码判定红包 */
  | "not_code"
  /** 其他错误，message 是原因 */
  | "error";

/** hb.submit() 的结果。 */
export type HbSubmitResult =
  | {
      judged: true;
      claimed: true;
      /** 领到多少，比如 "0.30" */
      amount: string;
      unit: "LDC" | "🐟";
      /** 代码的回复，没有就不带 */
      reply?: string;
    }
  | { judged: true; claimed: false; reply?: string }
  | {
      judged: false;
      reason: HbReason;
      seconds?: number;
      message?: string;
    };

/** hb.fill() 没填进去的原因。 */
export type HbFillReason =
  /** 直接领的红包不用输入，点红包上的「开」就领（限时开奖点「报」就报名） */
  | "no_input"
  /** 没登录：红包页弹出了登录卡片 */
  | "login"
  /** 还没开放 */
  | "not_open"
  /** 红包已结束 */
  | "ended"
  /** 代码连续出错，暂停领取 */
  | "paused"
  /** 已经领到过或报过名 */
  | "already_claimed"
  /** 不在领取范围 */
  | "not_in_scope"
  /** 指令框正在提交，等有了结果再填 */
  | "busy"
  /** 超过 200 字或有换行，message 是原因 */
  | "invalid_input"
  /** 看的人不在这个红包页上（网页还开着，但没在显示） */
  | "away";

/** hb.fill() 的结果。 */
export type HbFillResult =
  | { filled: true }
  | { filled: false; reason: HbFillReason; message?: string };

/** 看的人自己的一次提交。 */
export interface HbMyJudgment {
  /** 第几次，从 1 起 */
  n: number;
  at: string;
  input: string;
  claimed: boolean;
  amount?: string;
  reply?: string;
}

export interface Hb {
  version: 1;
  /** 等红包页接上；不在红包页里打开时报错（error.code 是 not_embedded）。 */
  ready(): Promise<{
    hongbao: HbHongbao;
    viewer: HbViewer;
    theme: "light" | "dark";
  }>;
  /** 判定器的公开数据，没有时 null。 */
  view(): Promise<HbView | null>;
  /** 有变化时调用 listener；返回取消订阅的函数。 */
  on(kind: "view", listener: (view: HbView | null) => void): () => void;
  on(kind: "hongbao", listener: (hongbao: HbHongbao) => void): () => void;
  on(
    kind: "announce",
    listener: (announcement: HbAnnouncement) => void,
  ): () => void;
  /** 替看的人提交一次，只有代码判定红包能用；同一个红包第一次会先问他允不允许。 */
  submit(input: string): Promise<HbSubmitResult>;
  /**
   * 把内容填进这个红包的指令框（和点红包打开的一样），不提交，按提交的是看的人
   * 自己；所有红包都能用。text 可以是空的，最多 200 个字，不能有换行。
   */
  fill(text: string): Promise<HbFillResult>;
  /** 看的人自己的提交，新的在前，一次 20 条；没登录时 null。 */
  mine(next?: string | null): Promise<{
    total: number;
    items: HbMyJudgment[];
    next: string | null;
  } | null>;
}

declare global {
  interface Window {
    hb: Hb;
  }
  const hb: Hb;
}
