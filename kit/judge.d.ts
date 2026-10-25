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
  /** 写了就整个换掉（发不发都存），不写就不变；最大 16 KB，最多嵌套 100 层 */
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

/** 时间：毫秒，或带时区的 ISO 时间（比如 "2026-10-24T12:00:00+08:00"；不带时区的不认）。 */
export type TestTime = number | string;

/**
 * tests.json：只是数据，平台不当代码跑，不算进指纹，不公开。
 * 所有测试加起来最多判定 200 次（多步的一步算一次）。
 */
export interface TestFile {
  /** 写 "./tests.schema.json"，编辑器就能补全、标错 */
  $schema?: string;
  tests: TestCase[];
}

/** 一条测试：一次提交，或者几个人依次提交（steps）。 */
export type TestCase = SingleTest | StepsTest;

/**
 * 两种测试都能写的：第一次提交之前红包的样子。没写的用默认值；
 * 剩余奖池、剩余份数和这一份的范围由 claims 推出来，不能直接写。
 * 只能写线上可能出现的情况，不然这条测试本身不通过。
 */
interface TestBase {
  /** 测试的名字，最多 100 个字，不能重名 */
  name: string;
  /** 这次提交的时间（多步的是第一步的），默认 2026-10-24 12:00（北京时间） */
  now?: TestTime;
  /** 默认：测试红包、10000、10 份、每份至少 1、now 前 1 小时开放、now 后 1 天截止 */
  hongbao?: Partial<
    Pick<Submission["hongbao"], "title" | "total" | "count" | "minEach">
  > & { openedAt?: TestTime; endsAt?: TestTime };
  /** 前面已领的份：数字（补上占位记录，每份平均）或完整列表；默认没人领 */
  claims?: number | TestClaim[];
  /** 代码之前存的状态，默认 null；最大 16 KB，最多嵌套 100 层 */
  state?: Json;
  /** 种子（64 位小写十六进制），默认固定的测试种子 */
  seed?: string;
}

/** 前面已领的一份：按先后，不早于开放，不晚于这次提交，同一个人只有一份。 */
export interface TestClaim {
  user: { id: number; username: string };
  /** 不少于每份至少 */
  amount: number;
  input: string;
  at: TestTime;
}

/** 一次提交：字段和 judge() 收到的 submission 同名。 */
export interface SingleTest extends TestBase {
  /** 规则同线上：一行、1–200 个字、去掉首尾空白 */
  input: string;
  /** 默认 id 10000、username tester、level 2、attempts 0 */
  user?: Partial<Submission["user"]>;
  expect: TestExpect;
  steps?: never;
}

/**
 * 几个人依次提交：状态、已领记录、每人被判定过几次、剩余奖池都像线上一样
 * 一步步往下传。已经领过的人、或者份已经领完了还要提交，这一步算不通过。
 */
export interface StepsTest extends TestBase {
  steps: TestStep[];
  input?: never;
  user?: never;
  expect?: never;
}

export interface TestStep {
  /** 谁提交的：同一个 who 是同一个人（username 就是它，id 按第一次出现的先后从 10001 编） */
  who: string;
  input: string;
  /** 信任等级，默认 2 */
  level?: 0 | 1 | 2 | 3 | 4 | null;
  /** 默认上一步往后 1 分钟，第一步是 now */
  at?: TestTime;
  expect: TestExpect;
}

/** 拉进范围的原因：封顶、保底、最后一份，发完剩下的。 */
export type JudgeNote = "cap" | "floor" | "last";

/**
 * 期望：ok 必填，其余写了才比，不一样的地方一起列出来。
 * 代码返回协议以外的字段也算不通过。
 */
export type TestExpect = (
  | {
      ok: true;
      /** 实际发的（拉进范围以后） */
      amount?: number;
      /** 代码自己给的 */
      asked?: number;
      /** 拉进范围的原因，没拉写 null */
      note?: JudgeNote | null;
    }
  | { ok: false; amount?: never; asked?: never; note?: never }
) &
  (
    | {
        /** 逐字比 */
        message?: string;
        messageIncludes?: never;
      }
    | {
        message?: never;
        /** 含这几个字 */
        messageIncludes: string;
      }
  ) &
  (
    | {
        /** 整份比，键的顺序不算 */
        state?: Json;
        stateIncludes?: never;
      }
    | {
        state?: never;
        /** 只比写了的键，数组整个比 */
        stateIncludes: { [key: string]: Json };
      }
  );

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
