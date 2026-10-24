/**
 * 代码判定红包 · 代码协议第一版。
 * 金额都是整数，单位是分（0.01）；时间都是毫秒。
 * 规则见 hb 仓库的 docs/programmable-hongbao-design.md 第 4 节。
 */

export type Json =
  | null
  | boolean
  | number
  | string
  | Json[]
  | { [key: string]: Json };

/** judge() 收到的第一个参数：这一次提交。 */
export interface Submission {
  /** 领的人输入的：已去掉首尾空白，1–200 个字 */
  input: string;
  /** 判定时间（服务器时钟）；Date.now()、new Date() 都是它 */
  now: number;
  user: {
    /** LINUX DO 数字 ID */
    id: number;
    username: string;
    /** 信任等级（上次登录时取的），没有时 null */
    level: 0 | 1 | 2 | 3 | 4 | null;
    /** 他在这个红包里之前被判定过几次（出错、超时不算） */
    attempts: number;
  };
  hongbao: {
    title: string;
    /** 总奖池 */
    total: number;
    /** 总份数 */
    count: number;
    /** 每份至少 */
    minEach: number;
    /** 剩余奖池 */
    remaining: number;
    /** 剩余份数（含这一份） */
    remainingCount: number;
    openedAt: number;
    endsAt: number;
  };
  /** 这一份能发的范围；last 时 min 和 max 都是剩余奖池 */
  share: { min: number; max: number; last: boolean };
  /** 已领到的，按先后 */
  claims: {
    user: { id: number; username: string };
    amount: number;
    input: string;
    at: number;
  }[];
  /** 代码上次存的，最开始是 null */
  state: Json;
}

/** judge() 的返回：发还是不发。 */
export interface Verdict {
  ok: boolean;
  /** ok 时必填：整数（分），平台再拉进 share 的范围 */
  amount?: number;
  /** 给领的人的一句话，发不发都用它；纯文字，最多 100 个字 */
  message?: string;
  /** 写了就整个换掉（发不发都存），不写就不变；最大 16 KB */
  state?: Json;
}

/** 可复现的随机数：同一个种子、同一个人、同一个第几次，取出来的都一样。 */
export interface Random {
  /** [0, 1) */
  next(): number;
  /** 含两端 */
  int(min: number, max: number): number;
  pick<T>(items: readonly T[]): T;
  /** 返回打乱后的新数组 */
  shuffle<T>(items: readonly T[]): T[];
}

/** judge() 收到的第二个参数：红包特有的工具，全是同步的。 */
export interface Tools {
  /** 这一次提交的随机流；Math.random() 也用它 */
  random: Random;
  /** 这个人固定的随机流：同一个人每次提交都一样 */
  userRandom: Random;
  /** 都按这一份的范围算，返回整数（分） */
  money: {
    /** 剩余平均：剩余奖池 ÷ 剩余份数，向下取整 */
    even(): number;
    /** 拼手气：double 是微信同款（二倍均值），bounded 是支付宝同款（均值上下 50%），用 random */
    lucky(kind?: "double" | "bounded"): number;
    /** 2000 → "20.00" */
    format(amount: number): string;
  };
  code: {
    /** HMAC-SHA256(key, parts 用换行接起来) → Crockford Base32，默认 10 位 */
    personal(
      key: string,
      parts: readonly (string | number)[],
      length?: number,
    ): string;
    /** RFC 6238，兼容验证器 App；secret 是 Base32；offset 是往前或往后几步，-1 是上一步 */
    totp(
      secret: string,
      options?: { step?: number; digits?: number; offset?: number },
    ): string;
    /** now 落在第几个 seconds 秒长的时间段 */
    window(seconds: number): number;
    /** 按 Crockford 比：不分大小写，O=0、I/L=1，忽略空格和横线 */
    same(input: string, code: string): boolean;
  };
  text: {
    /** NFKC、去零宽字符、合并空白、转小写 */
    normalize(text: string): string;
  };
  time: {
    /** now 在某个时区的日期时间，默认 Asia/Shanghai；weekday 1 是周一，7 是周日 */
    parts(timeZone?: string): {
      year: number;
      month: number;
      day: number;
      hour: number;
      minute: number;
      second: number;
      weekday: number;
    };
  };
}

export type Judge = (
  submission: Submission,
  tools: Tools,
) => Verdict | Promise<Verdict>;

/** tests.json 的一条。没写的字段用默认值。 */
export interface TestCase {
  name: string;
  input: string;
  user?: Partial<Submission["user"]>;
  hongbao?: Partial<Submission["hongbao"]>;
  /** 写数字表示前面已经领了几份 */
  claims?: number | Submission["claims"];
  state?: Json;
  /** 毫秒或 ISO 时间 */
  now?: number | string;
  /** 64 位十六进制的种子 */
  seed?: string;
  expect: {
    ok: boolean;
    /** 实际发出的金额（拉进范围以后） */
    amount?: number;
    message?: string;
    state?: Json;
  };
}

/**
 * 发红包的人下载的完整领取记录（网站上“下载完整记录”）：每次判定交给代码的
 * 输入和那时的情况，加上代码的回答；npm run replay 拿它逐条重放核对。
 * 已领记录、剩余奖池和状态都由前面的判定推出来，不重复写。
 */
export interface JudgeRecords {
  protocol: number;
  hongbao: {
    id: string;
    total: number;
    count: number;
    minEach: number;
    openedAt: number;
    endsAt: number;
    /** judge.js 的 SHA-256 */
    fingerprint: string;
    seedCommitment: string;
    /** 结束后才有 */
    seed: string | null;
  };
  /** 按判定的先后 */
  judgments: {
    /** Submission.now */
    at: number;
    input: string;
    user: Submission["user"];
    /** 那时的红包标题 */
    title: string;
    /** 代码的回答（读过以后：message 合并了空白）；写了 state 才有 state */
    verdict: { ok: boolean; amount?: number; message?: string; state?: Json };
    /** 实际发的，和拉进范围的原因 */
    paid?: number;
    note?: "floor" | "cap" | "last";
    /** 这一份领到的时间；没领成（比如到点结束了）就没有 */
    claimedAt?: number;
  }[];
}
