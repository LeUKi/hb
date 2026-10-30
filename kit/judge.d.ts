/**
 * 代码判定红包 · 代码协议第五版（第四版加上每个人的待结算、自己的状态、
 * 只给自己看的数据和同桌的人）。
 * 金额都是整数，单位是分（0.01）；时间都是毫秒。
 * 规则见 hb 仓库的 docs/programmable-hongbao-design.md 第 4 节，联网见第 9 节，
 * 参数（meta、params、hongbao、check）见 docs/judge-square-design.md 第 3、4 节，
 * 公开数据（view、announce、end、setup）见 docs/judge-page-design.md 第 2 节，
 * 待结算和结算（add、settle、player、others）见 docs/multi-prize-design.md 第 3 节。
 *
 * 一句话规则：每个人在一个红包里最后只结算一次。每次判定，判定器说给他加或减多少；
 * 判定器说“结算”，或者红包结束，他那时的待结算一次发给他。没有份数，只有总奖池。
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
    /**
     * 奖池里还没被占的：总奖池减去已经结算的，再减去大家的待结算。加钱加不过它；
     * 变成 0 时红包马上结束，所有还没结算的人一起结算
     */
    unclaimed: number;
    /** 剩余奖池：总奖池减去已经结算的（还没减大家的待结算） */
    remaining: number;
    /** 兼容旧代码：没有份数了，这里是总奖池按 LDC 取整（最少 1），也是 even() 缺省的 n */
    count: number;
    /** 兼容旧代码：一律 1（0.01） */
    minEach: number;
    /** 兼容旧代码：count 减去已经领到钱的人数，最少 1 */
    remainingCount: number;
    openedAt: number;
    endsAt: number;
  };
  /** 兼容旧代码：min 是 1，max 是 hongbao.unclaimed，last 一律 false */
  share: { min: number; max: number; last: boolean };
  /**
   * 已经结算、领到钱的，按结算的先后（结算 0 的不在里面）。input 是这个人最后一次
   * 提交的，at 是结算的时间
   */
  claims: {
    user: { id: number; username: string };
    amount: number;
    input: string;
    at: number;
  }[];
  /** 代码上次存的，整个红包共用一份，最开始是 null */
  state: Json;
  /** 这次提交的人自己的：待结算、判定器给他存的状态和只给他看的数据 */
  player: {
    /** 待结算（分），从 0 开始 */
    pending: number;
    /** 判定器上次给他存的，最开始是 null；只有判定器看得到 */
    state: Json;
    /** 只给他看的数据，最开始是 null */
    view: View | null;
  };
  /**
   * 发红包的人在参数表单里填的（按 params 的声明校验过；没声明 params 是 {}）。
   * 金额是整数分；没填的选填项：开关是 false，列表和表格是 []，其他是 null。
   */
  params: Params;
}

/**
 * judge() 的返回：给这次提交的人加减多少、结算不结算，写哪些状态。都不写（{}）就是
 * 什么都不变，他接着能玩。
 *
 * 平台怎么算：先加减这次提交的人，再按顺序加减 others 里的人；每个人扣到 0 为止，
 * 加的不超过奖池里还没被占的（hongbao.unclaimed）；然后结算说了要结算的人。
 */
export interface Verdict {
  /** 给这次提交的人加多少，整数（分），可以是负数；不写就是 0 */
  add?: number;
  /** true：现在给这次提交的人结算（可以和这次的 add 一起写），之后他不能再提交 */
  settle?: boolean;
  /**
   * 这次提交的人自己的：state 最大 4 KB，只有判定器看得到；view 只给他看
   * （summary 最多 200 个字，data 最大 4 KB）。写了哪样就整个换掉哪样，不写不变，
   * view 写 null 是清空
   */
  player?: { state?: Json; view?: View | null };
  /**
   * 同桌的人，最多 10 个：只能写给在这个红包里被判定过、还没结算、在领取范围以内的人，
   * 不能写给自己。写了不能写的人，这次判定算出错
   */
  others?: Other[];
  /**
   * 旧写法，是简写：{ ok: true, amount } 等于 { add: amount, settle: true }，
   * { ok: false } 等于什么都不加、不结算。不能和 add、settle 一起写
   */
  ok?: boolean;
  /** 旧写法：ok 为 true 时必填，整数（分） */
  amount?: number;
  /** 给提交的人的一句话；纯文字，最多 100 个字 */
  message?: string;
  /** 写了就整个换掉（发不发都存），不写就不变；最大 64 KB，最多嵌套 100 层 */
  state?: Json;
  /**
   * 第四版：公开数据，所有人都看得到（游客也是）。写了就整个换掉，不写不变，
   * null 是清空。秘密照旧放在 state 里
   */
  view?: View | null;
  /** 第四版：一条动态，纯文字，最多 100 个字；网站在前面写上判定的人 */
  announce?: string;
  /** 第四版：true 就在这次判定后结束红包：还没结算的人一起结算，没发的照提前结束退回 */
  end?: boolean;
}

/** 第五版：给同桌的一个人的。 */
export interface Other {
  /** LINUX DO 数字 ID，同 submission.user.id */
  id: number;
  /** 给他加多少，整数（分），可以是负数 */
  add?: number;
  /** true：现在给他结算 */
  settle?: boolean;
  /** 他的状态，整个换掉；最大 4 KB */
  state?: Json;
  /** 只给他看的数据，整个换掉；null 是清空 */
  view?: View | null;
  /** 给他看的一句话，纯文字，最多 100 个字 */
  message?: string;
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
  /**
   * 按“奖池里还没被占的分成 n 份”算，返回整数（分）。n 是正整数，不传就是
   * hongbao.count（总奖池按 LDC 取整，每份约 1 LDC）；已经领到钱的人算用掉的份，
   * 剩下最后一份时给全部
   */
  money: {
    /** 平均：没被占的 ÷（n − 已经领到钱的人数），向下取整 */
    even(n?: number): number;
    /** 拼手气：double 是微信同款（二倍均值），bounded 是支付宝同款（均值上下 50%），用 random */
    lucky(kind?: "double" | "bounded", n?: number): number;
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
  /** 不起作用了：第五版没有份数 */
  count?: { min?: number; max?: number; default?: number };
  /** 总奖池 */
  total?: { min?: number; max?: number; default?: number };
  /** 不起作用了：第五版没有每份至少 */
  minEach?: { min?: number; default?: number };
  /** 默认的截止时长（从开放算起） */
  deadline?: { value: number; unit: "minutes" | "hours" | "days" };
  /** 领取提示的默认值，最多 40 个字 */
  prompt?: string;
  /** 建议打开领取前人机验证（发红包的人能关） */
  humanCheck?: boolean;
  /** 红包标题的默认值，最多 100 个字 */
  title?: string;
  /**
   * 说明的默认值，最多 2000 个字。写法同发红包时的说明：一个回车就换行，
   * `[文字](#附带网页)` 是打开附带网页的按钮（没有网页时只剩文字）。
   */
  note?: string;
}

/** judge.js 导出 `meta`：贴代码时填好判定器的名字和说明，之后以网站上的为准。 */
export interface Meta {
  /** 最多 20 个字 */
  name: string;
  /** 最多 60 个字 */
  description?: string;
  /**
   * 判定器带的附带网页（https，规则同附带网页，最多 500 个字）：用它发红包时
   * 替发红包的人填好。
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
 * 不能大于最大、题目至少要有一道。返回问题的数组，没问题返回 []。
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
 * 单个请求 10 秒、返回最大 64 KB，不跟随跳转；不行时 fetch() 抛 TypeError（“联网失败：…”）。
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
 * 剩余奖池、奖池里还没被占的由 claims 和 players 推出来，不能直接写。
 * 只能写线上可能出现的情况，不然这条测试本身不通过。
 */
interface TestBase {
  /** 测试的名字，最多 100 个字，不能重名 */
  name: string;
  /** 这次提交的时间（多步的是第一步的），默认 2026-10-24 12:00（北京时间） */
  now?: TestTime;
  /**
   * 默认：测试红包、总奖池 10000、now 前 1 小时开放、now 后 1 天截止。
   * 第五版没有份数和每份至少，写 count、minEach 这条测试不通过
   */
  hongbao?: Partial<Pick<Submission["hongbao"], "title" | "total">> & {
    openedAt?: TestTime;
    endsAt?: TestTime;
  };
  /**
   * 前面已经结算、领到钱的人：数字（补上占位记录，每人约 1 LDC）或完整列表；
   * 默认没有。加起来要少于总奖池
   */
  claims?: number | TestClaim[];
  /**
   * 前面已经玩过、还没结算的人：名字对应他的待结算、状态和只给他看的数据，比如
   * { "小明": { "pending": 50, "state": { "tries": 2 } } }。这次提交的人（单次测试的
   * user.username、多步的 who）也可以在里面
   */
  players?: { [name: string]: TestPlayer };
  /** 代码之前存的状态，默认 null；最大 64 KB，最多嵌套 100 层 */
  state?: Json;
  /** 种子（64 位小写十六进制），默认固定的测试种子 */
  seed?: string;
  /**
   * 这条测试的参数，按 params 的声明校验（没写的项用 default），代码导出了 check
   * 也要过 check；默认用文件顶层的 params
   */
  params?: Params;
}

/** 第五版：前面已经玩过、还没结算的一个人。 */
export interface TestPlayer {
  /** 待结算（分），默认 0 */
  pending?: number;
  /** 判定器给他存的，默认 null；最大 4 KB */
  state?: Json;
  /** 只给他看的数据，默认 null */
  view?: View | null;
}

/** 前面已经领到钱的一个人：按先后，不早于开放，不晚于这次提交，同一个人只有一条。 */
export interface TestClaim {
  user: { id: number; username: string };
  /** 正整数（分） */
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
 * 几个人依次提交：状态、每个人的待结算和状态、已经结算的、奖池都像线上一样
 * 一步步往下传。已经结算的人、或者红包结束了还要提交，这一步算不通过。
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

/** 第四版以前：拉进范围的原因：封顶、保底、最后一份，发完剩下的。 */
export type JudgeNote = "cap" | "floor" | "last";

/** 第五版：一个人这次判定以后的样子。 */
export interface TestPart {
  /** 待结算（分）；结算以后是 0 */
  pending?: number;
  /** 结算的金额（分），可以是 0；还没结算写 null */
  settled?: number | null;
  /** 他的状态，整份比 */
  state?: Json;
  /** 只比写了的键 */
  stateIncludes?: { [key: string]: Json };
  /** 只给他看的数据，整份比；没有写 null */
  view?: View | null;
  viewIncludes?: { summary?: string; data?: Json };
}

/**
 * 期望：写了才比，不一样的地方一起列出来（什么都不写，就只看能不能跑通）。
 * 代码返回协议以外的字段也算不通过。
 */
export type TestExpect = {
  /** 简写：这次判定有没有给提交的人结算、并且领到钱（结算 0 不算） */
  ok?: boolean;
  /** 简写：这次结算领到的（分） */
  amount?: number;
  /** 判定器给提交的人的 add（{ ok: true, amount } 的 add 就是 amount） */
  add?: number;
  /** 判定器有没有说给提交的人结算 */
  settle?: boolean;
  /** 提交的人这次以后的待结算 */
  pending?: number;
  /** 提交的人结算的金额，还没结算写 null */
  settled?: number | null;
  /** 提交的人这次以后自己的状态和只给他看的数据，写了的那项整份比 */
  player?: { state?: Json; view?: View | null };
  /** 同上，只比写了的键 */
  playerIncludes?: {
    state?: { [key: string]: Json };
    view?: { summary?: string; data?: Json };
  };
  /**
   * 按名字（who、username）：这些人这次以后的样子，message 是 others 这次写给他的话
   * （没写给他写 ""）
   */
  people?: { [name: string]: TestPart & { message?: string } };
} & (
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
    /** 这次判定以后红包结束了没有（end 结束的，或者奖池被占满了） */
    end?: boolean;
  };

/**
 * 红包作者下载的完整领取记录（网站上“下载完整记录”）：每次判定交给代码的
 * 输入和那时的情况，加上代码的回答；npm run replay 拿它逐条重放核对。
 * 已领记录、剩余奖池和状态都由前面的判定推出来，不重复写。
 */
export interface JudgeRecords {
  /** 红包开放时用的协议版本：1 到 5 */
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
    /** 第四版以前才有：份数、每份至少 */
    count?: number;
    minEach?: number;
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
     * 第四版：写了 view 才有 view，有动态才有 announce，结束了红包才有 end。
     * 第五版：写了什么就有什么（add、settle、player、others，或者旧写法 ok、amount）；
     * 每个人的待结算和结算由前面的判定推出来
     */
    verdict: {
      ok?: boolean;
      amount?: number;
      add?: number;
      settle?: true;
      player?: { state?: Json; view?: View | null };
      others?: Other[];
      message?: string;
      state?: Json;
      view?: View | null;
      announce?: string;
      end?: true;
    };
    /** 第四版以前：实际发的，和拉进范围的原因 */
    paid?: number;
    note?: "floor" | "cap" | "last";
    /** 第四版以前：这一份领到的时间；没领成（比如到点结束了）就没有 */
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
