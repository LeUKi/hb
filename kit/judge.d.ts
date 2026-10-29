/**
 * 代码判定红包 · 代码协议第四版（第三版加上公开数据、动态和提前结束）。
 * 金额都是整数，单位是分（0.01）；时间都是毫秒。
 * 规则见 hb 仓库的 docs/programmable-hongbao-design.md 第 4 节，联网见第 9 节，
 * 参数（meta、params、hongbao、check）见 docs/judge-square-design.md 第 3、4 节，
 * 公开数据（view、announce、end、setup）见 docs/judge-page-design.md 第 2 节。
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
  /**
   * 发红包的人在参数表单里填的（按 params 的声明校验过；没声明 params 是 {}）。
   * 金额是整数分；没填的选填项：开关是 false，列表和表格是 []，其他是 null。
   */
  params: Params;
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
  /**
   * 第四版：公开数据，所有人都看得到（游客也是）。写了就整个换掉，不写不变，
   * null 是清空。秘密照旧放在 state 里
   */
  view?: View | null;
  /** 第四版：一条动态，纯文字，最多 100 个字；网站在前面写上判定的人 */
  announce?: string;
  /** 第四版：true 就在这次判定后结束红包（这次照常结算，没发的照提前结束退回） */
  end?: boolean;
}

/** 第四版：公开数据。 */
export interface View {
  /** 给所有人看的一句话，网站自己显示；纯文字，最多 200 个字 */
  summary?: string;
  /** 给附带网页的，什么结构都行；最大 16 KB，最多嵌套 100 层 */
  data?: Json;
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

/** 参数的值：submission.params 里每个 key 一个。 */
export type ParamValue =
  | string
  | number
  | boolean
  | null
  | string[]
  | Record<string, string | number | null>[];
export type Params = Record<string, ParamValue>;

/** 每个参数都能写的。 */
interface ParamBase {
  /** 字母、数字和下划线，最多 32 个字；代码里用 submission.params[key] 取 */
  key: string;
  /** 表单上的名字，最多 20 个字 */
  label: string;
  /** 表单上的一句说明，最多 60 个字 */
  hint?: string;
  /** 默认 true */
  required?: boolean;
  /** 保密：开放时只公布参数封存值，结束后公开。默认 false */
  secret?: boolean;
}

/** 表格的一列。 */
export type TableColumn = {
  key: string;
  label: string;
  /** 默认 true */
  required?: boolean;
} & (
  | { type: "text"; minLength?: number; maxLength?: number }
  | { type: "integer"; min?: number; max?: number; step?: number }
  | { type: "money"; min?: number; max?: number }
);

/**
 * 参数的声明：judge.js 导出 `params`（这种声明的数组，最多 20 项），网站按它画出
 * 发红包时填的表单。金额（money）是整数分，min 至少 1。
 */
export type ParamDeclaration = ParamBase &
  (
    | { type: "text"; minLength?: number; maxLength?: number; default?: string }
    | { type: "textarea"; maxLength?: number; default?: string }
    | {
        type: "integer";
        min?: number;
        max?: number;
        step?: number;
        default?: number;
      }
    | { type: "money"; min?: number; max?: number; default?: number }
    | { type: "switch"; default?: boolean }
    | {
        type: "choice";
        /** 2–20 个 */
        options: { value: string; label: string }[];
        default?: string;
      }
    | {
        type: "list";
        minItems?: number;
        /** 最多 100 */
        maxItems?: number;
        /** 每项最多几个字，最多 200 */
        maxLength?: number;
        default?: string[];
      }
    | {
        type: "table";
        /** 1–6 列 */
        columns: TableColumn[];
        minRows?: number;
        /** 最多 100 */
        maxRows?: number;
        default?: Record<string, string | number | null>[];
      }
  );

/**
 * judge.js 导出 `hongbao`：用它发的红包在“发多少”这一步的默认值和范围，
 * 只能收窄平台的规则。金额是整数分。
 */
export interface HongbaoRules {
  /** 份数，1–1000 之内 */
  count?: { min?: number; max?: number; default?: number };
  /** 总奖池 */
  total?: { min?: number; max?: number; default?: number };
  /** 每份至少 */
  minEach?: { min?: number; default?: number };
  /** 默认的截止时长（从开放算起） */
  deadline?: { value: number; unit: "minutes" | "hours" | "days" };
  /** 领取提示的默认值，最多 40 个字 */
  prompt?: string;
  /** 建议打开领取前人机验证（发红包的人能关） */
  humanCheck?: boolean;
}

/** judge.js 导出 `meta`：贴代码时填好判定器的名字和说明，之后以网站上的为准。 */
export interface Meta {
  /** 最多 20 个字 */
  name: string;
  /** 最多 60 个字 */
  description?: string;
  /**
   * 判定器带的附带网页（https，规则同附带网页，最多 500 个字）：用它发红包时
   * 替发红包的人填好，没开通 PLUS 也能用。
   */
  page?: string;
}

/** check() 说的一个问题：哪个参数、错在哪（最多 100 个字）。 */
export interface ParamProblem {
  key: string;
  message: string;
}

/**
 * judge.js 可以导出 `check(params, hongbao)`：查单看每一项查不出来的，比如最小
 * 不能大于最大、题目不能比份数少。返回问题的数组，没问题返回 []。
 * 发红包的人填参数时在判定器里跑，Math.random() 每次都一样，不能联网。
 */
export type Check = (
  params: Params,
  hongbao: Pick<Submission["hongbao"], "title" | "total" | "count" | "minEach">,
) => ParamProblem[] | Promise<ParamProblem[]>;

/**
 * 第四版：judge.js 可以导出 `setup(params, hongbao)`，开放时跑一次（算一次沙箱使用），
 * 返回最开始的 state 和公开数据；不导出就是 state 为 null、没有公开数据。
 * Math.random() 来自开放时封存的种子，结束后能重放核对；不能联网。出错红包就开放不了。
 */
export type Setup = (
  params: Params,
  hongbao: Pick<Submission["hongbao"], "title" | "total" | "count" | "minEach">,
) =>
  | { state?: Json; view?: View | null }
  | undefined
  | Promise<{ state?: Json; view?: View | null } | undefined>;

/**
 * 联网：judge.js 导出 network，列出能请求的地址前缀，最多 3 个；不导出就不联网。
 * 写法：https:// 开头的完整域名加路径前缀，比如 "https://api.example.com/hongbao/"；
 * 不带端口、? 和 #，不能是 IP 地址、linux.do 和本站。
 * 判定里直接用 fetch()：每次判定最多 3 个请求，只许 GET 和 POST，请求体最大 16 KB，
 * 单个请求 3 秒、返回最大 64 KB，不跟随跳转；不行时 fetch() 抛 TypeError（“联网失败：…”）。
 * 代码结束后公开，写在里面的令牌也会公开；红包结束后，领的人能看到自己那几次判定的返回内容。
 */
export type Network = readonly string[];

/**
 * 测试里一个请求的返回（tests.json 和 simulate.json 的 fetch）：
 * 代码发出的请求按方法和完整地址对上一个还没用过的。
 */
export type FetchAnswer =
  | {
      url: string;
      /** 默认 GET */
      method?: "GET" | "POST";
      /** 默认 200 */
      status?: number;
      headers?: { [name: string]: string };
      /** 返回的 JSON（content-type 默认 application/json）；和 text 二选一 */
      json?: Json;
      text?: string;
      error?: never;
    }
  | {
      url: string;
      method?: "GET" | "POST";
      /** 这个请求失败：超时、连不上、返回超过 64 KB */
      error: "timeout" | "unreachable" | "too-big";
    };

/** 时间：毫秒，或带时区的 ISO 时间（比如 "2026-10-24T12:00:00+08:00"；不带时区的不认）。 */
export type TestTime = number | string;

/**
 * tests.json：只是数据，平台不当代码跑，不算进指纹，不公开。
 * 所有测试加起来最多判定 200 次（多步的一步算一次）。
 */
export interface TestFile {
  /** 写 "./tests.schema.json"，编辑器就能补全、标错 */
  $schema?: string;
  /** 每条测试默认用的参数（测试自己写了 params 就用自己的） */
  params?: Params;
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
  /**
   * 这条测试的参数，按 params 的声明校验（没写的项用 default），代码导出了 check
   * 也要过 check；默认用文件顶层的 params
   */
  params?: Params;
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
  /** 这次判定的请求拿到的返回，最多 3 个；有请求没写到、写了没用上，都不通过 */
  fetch?: FetchAnswer[];
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
  /** 这一步的请求拿到的返回，最多 3 个 */
  fetch?: FetchAnswer[];
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
  ) &
  (
    | {
        /** 第四版：这次判定后的公开数据，整份比；没有公开数据写 null */
        view?: View | null;
        viewIncludes?: never;
      }
    | {
        view?: never;
        /** 只比写了的键，同 stateIncludes */
        viewIncludes: { summary?: string; data?: Json };
      }
  ) & {
    /** 第四版：这次的动态，逐字比；没有动态写 "" */
    announce?: string;
    /** 第四版：这次判定有没有结束红包 */
    end?: boolean;
  };

/**
 * 红包作者下载的完整领取记录（网站上“下载完整记录”）：每次判定交给代码的
 * 输入和那时的情况，加上代码的回答；npm run replay 拿它逐条重放核对。
 * 已领记录、剩余奖池和状态都由前面的判定推出来，不重复写。
 */
export interface JudgeRecords {
  /** 红包开放时用的协议版本：1、2、3 或 4 */
  protocol: number;
  /** 第二版起联网的红包：白名单 */
  network?: string[];
  /** 第三版：发红包时填的参数，保密的也在（这份记录只给红包作者） */
  params?: Params;
  /**
   * 第三版：保密参数的封存值，开放时公布；结束后有盐，npm run replay 拿 params 里
   * 这几项核对：SHA-256（按键排序的保密参数 JSON、换行、盐）
   */
  paramsSealed?: { keys: string[]; commitment: string; salt: string | null };
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
  /**
   * 第四版：开放时 setup() 的回答（导出了 setup 才有）：那时的时间和标题，
   * 写了才有 state、view
   */
  setup?: { at: number; title: string; state?: Json; view?: View | null };
  /** 按判定的先后 */
  judgments: {
    /** Submission.now */
    at: number;
    input: string;
    user: Submission["user"];
    /** 那时的红包标题 */
    title: string;
    /**
     * 代码的回答（读过以后：message 合并了空白）；写了 state 才有 state。
     * 第四版：写了 view 才有 view，有动态才有 announce，结束了红包才有 end
     */
    verdict: {
      ok: boolean;
      amount?: number;
      message?: string;
      state?: Json;
      view?: View | null;
      announce?: string;
      end?: true;
    };
    /** 实际发的，和拉进范围的原因 */
    paid?: number;
    note?: "floor" | "cap" | "last";
    /** 这一份领到的时间；没领成（比如到点结束了）就没有 */
    claimedAt?: number;
    /** 联网（第二版）：这次判定发出的请求和拿到的返回，按先后；返回按 UTF-8 文本记 */
    fetches?: {
      method: "GET" | "POST";
      url: string;
      body?: string;
      status?: number;
      contentType?: string;
      response?: string;
      /** 失败：超时、连不上、返回超过 64 KB */
      error?: "timeout" | "unreachable" | "too-big";
      ms: number;
    }[];
  }[];
}
