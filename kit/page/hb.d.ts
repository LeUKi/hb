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
  /** 红包没公开份数时是 null；代码判定红包没有份数，也是 null */
  shares: { total: number; claimed: number; remaining: number } | null;
  /** 奖池总额，比如 "10.00"；没有时 null */
  pool: string | null;
  /**
   * 代码判定红包的奖池还剩多少，比如 "12.50"：总奖池减去已经结算的和大家的
   * 待结算；别的红包是 null
   */
  unclaimed: string | null;
  deadlineAt: string | null;
  /** 已判定几次 */
  judged: number | null;
  /**
   * 代码判定红包现在公开的参数（key → 值），同红包页代码一节列出的：结束后公开的
   * 结束后才有，密钥永远没有；没有参数时是 {}。地址参数是规范后的地址，以 / 结尾。
   * 只用来显示：后端要用的从红包信息接口读，网页交上去的能被改
   */
  params: Record<string, unknown>;
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
  /** 已经领到过或已经结算了 */
  | "already_claimed"
  /** 还没开放 */
  | "not_open"
  /** 红包已结束 */
  | "ended"
  /** 判定器连续出错，暂停领取 */
  | "paused"
  /** 判定器出错了，这次没有判定，可以再提交 */
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

/** 代码判定红包的一次判定给提交的人带来的变化。 */
export interface HbMoved {
  /** 这次加减了多少，比如 "0.50"、"-0.20"、"0.00" */
  added: string;
  /** 这次以后的待结算，比如 "1.20"；结算以后是 "0.00" */
  pending: string;
  /** 这次结算了他（之后不能再提交） */
  settled: boolean;
}

/** hb.submit() 的结果。 */
export type HbSubmitResult =
  | ({
      judged: true;
      /** 结算了，领到了钱 */
      claimed: true;
      /** 领到多少，比如 "0.30" */
      amount: string;
      unit: "LDC" | "🐟";
      /** 判定器的回复，没有就不带 */
      reply?: string;
    } & Partial<HbMoved>)
  | ({ judged: true; claimed: false; reply?: string } & Partial<HbMoved>)
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
  /** 判定器连续出错，暂停领取 */
  | "paused"
  /** 已经领到过、报过名或已经结算了 */
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

/** hb.me()：看的人自己的情况。 */
export type HbMe =
  | { signedIn: false }
  | {
      signedIn: true;
      /** 昵称 */
      name: string;
      /** 现在能不能参加（领取、报名或提交给判定器） */
      open: boolean;
      /** 不能参加的原因 */
      why?:
        | "not_open"
        | "ended"
        | "paused"
        | "already_claimed"
        | "not_in_scope";
      /** 冷却到什么时候（服务器时间，毫秒，同 hb.now()）；没在冷却时 null */
      cooldownUntil: number | null;
      /** 领到的；没领到时 null */
      claim: {
        amount: string;
        unit: "LDC" | "🐟";
        /** paid 已到账，paying 正在付，failed 没发出，none 不付款（发红包的人自己领的） */
        payment: "paid" | "paying" | "failed" | "none";
      } | null;
      /** 限时开奖：已经报了名 */
      registered: boolean;
      /** 代码判定红包：待结算，比如 "1.20"；还没被判定过、别的红包时 null */
      pending: string | null;
      /** 代码判定红包：已经结算了（领到的钱在 claim 里，结算时是 0 则 claim 是 null） */
      settled: boolean;
    };

/** hb.identity() 没拿到令牌的原因。 */
export type HbIdentityReason =
  /** 没登录：在看的人点了网页里的按钮时调 hb.login() */
  | "login"
  /** 他不允许 */
  | "denied"
  /** 网页不在它的红包页上 */
  | "away"
  /** 上一次 hb.identity() 还没回来 */
  | "busy"
  /** 这个红包没有附带网页，或者红包站暂时签不了 */
  | "unavailable"
  /** 别的错，message 是原因 */
  | "error";

/**
 * hb.identity() 的结果。token 是红包站签名的 JWT（ES256，10 分钟），交给网页
 * 自己的后端验证，后端只信它：公钥在 https://hb.lafi.sh/api/page-identity/keys，
 * 要核对 iss（https://hb.lafi.sh）、aud（你网页的来源）、exp、hongbao（红包
 * 编号）和你发的 nonce。令牌里的 sender 是发这个红包的人的 LINUX DO 数字 ID：
 * 发红包的人自己部署的服务只认自己的红包时核对它；judge、judgeVersion 是代码判定
 * 红包的判定器编号和第几版：大家共用的后端只给自己的判定器用时核对它。后端要红包的
 * 状态和玩法参数，读 https://hb.lafi.sh/api/hongbao/<红包编号>（见 AGENTS.md 的
 * “后端认人和读红包”）。user 只是方便网页先显示。
 */
export type HbIdentityResult =
  | {
      identified: true;
      token: string;
      /** 令牌什么时候过期（ISO 时间）；过期了再调一次，不会再问他 */
      expiresAt: string;
      user: {
        /** LINUX DO 数字 ID（字符串），同令牌的 sub、判定器的 submission.user.id */
        id: string;
        username: string;
        /** 昵称 */
        name: string;
        /** 信任等级 0–4，没有时 null */
        level: number | null;
      };
    }
  | { identified: false; reason: HbIdentityReason; message?: string };

/** 判定器写给看的人自己的数据（判定结果的 player.view），只有他看得到。 */
export interface HbMyView {
  summary: string | null;
  data: unknown;
}

/**
 * 看的人自己的一条记录：他的一次提交，或者别人的一次判定通过 others 改到了他
 * （这时有 by，没有 input）。
 */
export interface HbMyJudgment extends Partial<HbMoved> {
  /** 第几次，从 1 起；by 时是那个人的第几次 */
  n: number;
  at: string;
  /** 他提交的输入；by 时没有 */
  input?: string;
  /** 别人的判定改到了他：那个人的昵称 */
  by?: string;
  /** 结算了，领到了钱 */
  claimed: boolean;
  amount?: string;
  /** 判定器的回复；by 时是判定器写给他的话 */
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
  on(kind: "me", listener: (me: HbMe) => void): () => void;
  on(kind: "myView", listener: (myView: HbMyView | null) => void): () => void;
  /** 看的人自己的情况，变了用 hb.on("me", fn) 订阅。 */
  me(): Promise<HbMe>;
  /**
   * 代码判定红包里判定器写给看的人自己的数据，没有、没登录时 null；变了用
   * hb.on("myView", fn) 订阅。
   */
  myView(): Promise<HbMyView | null>;
  /** 按服务器校准过的当前时间（毫秒）；看的人没登录时是本机时间。 */
  now(): number;
  /**
   * 请红包页弹出登录卡片。要在看的人点了网页里的按钮时调用，否则报错
   * （error.code 是 no_gesture）。已经登录时 { signedIn: true }。
   */
  login(): Promise<{ signedIn: true } | { signedIn: false; opened: boolean }>;
  /** 替看的人提交一次，只有代码判定红包能用；同一个红包第一次会先问他允不允许。 */
  submit(input: string): Promise<HbSubmitResult>;
  /**
   * 把内容填进这个红包的指令框（和点红包打开的一样），不提交，按提交的是看的人
   * 自己；所有红包都能用。text 可以是空的，最多 200 个字，不能有换行。
   */
  fill(text: string): Promise<HbFillResult>;
  /**
   * 拿一个红包站签名的身份令牌，交给网页自己的后端验证；所有带附带网页的红包都
   * 能用。同一个红包第一次会先问他（代码判定红包和替你提交一起问）。nonce 可选：
   * 后端先发的一次性随机串，8–128 个字母、数字或 -_.~，原样签进令牌，防重放。
   */
  identity(options?: { nonce?: string }): Promise<HbIdentityResult>;
  /** 看的人自己的记录（他的提交和别人的判定改到他的），新的在前，一次 20 条；没登录时 null。 */
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
