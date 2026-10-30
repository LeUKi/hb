import {
  ACTIVITY_LIMITS,
  type ActivityInput,
  amountToMinor,
  boundedMeanLimits,
  CLAIM_SCOPE_LIMITS,
  type ClaimScope,
  DEFAULT_DRAW_COUNTDOWN_SECONDS,
  JUDGE_LIMITS,
  JUDGE_NAME_LIMITS,
  type JudgeDeclarations,
  type JudgeHongbaoRules,
  type JudgeSource,
  type JudgeVersions,
  type LdcMoney,
  type ManagedActivity,
  normalizePageUrl,
  normalizeTopicLink,
  pageUrlProblem,
  sameLdcMoney,
  TRUST_LEVEL_MAX,
  TRUST_LEVEL_MIN,
} from "@hb/contracts";
import { durationOfSeconds } from "../../lib/hongbao";
import { inspectPassword } from "../../lib/password-rules";
import { noVersions } from "./judge-versions";

// The 发红包 flow (/new) and the sender's 📝 编辑: one state shape, its
// checks, and the conversion to and from production's ActivityInput. Limits
// follow production's contracts (ACTIVITY_LIMITS, LDC amounts);
// docs/redesign/07 §5 has the reasoning.

export const LIMITS = {
  title: 100,
  passwords: ACTIVITY_LIMITS.passwords,
  shares: 1000,
  info: 10_000,
} as const;

export type RewardMode = LdcMoney["mode"];
export type Algorithm = "double_mean" | "bounded_mean";
/** Seconds only for a timed draw's countdown: a deadline is in minutes. */
export type TimeUnit = "seconds" | "minutes" | "hours" | "days";

export type FormState = {
  title: string;
  /** 从哪发: the merchant pays each claim, or 🐟额 (balance-design §14). */
  funding: "merchant" | "balance";
  mode: RewardMode;
  fixed: { unit: string; count: string };
  random: { total: string; count: string; algorithm: Algorithm };
  custom: { lines: string; order: "sequential" | "random" };
  draw: {
    pool: string;
    winners: string;
    /** 报名上限; empty = no limit. */
    limit: string;
    algorithm: Algorithm;
    /** 人数不足时发完奖池. */
    fillPool: boolean;
  };
  /**
   * 代码判定 (docs/programmable-hongbao-design.md): a pool, shares and
   * 每份至少, then the prompt, judge.js and tests.json as pasted, and the
   * versions deployed (§5 版本, 换回: judge-versions.ts).
   */
  judge: {
    total: string;
    count: string;
    minEach: string;
    prompt: string;
    code: string;
    tests: string;
    versions: JudgeVersions;
    /**
     * 判定器 (docs/judge-square-design.md §1): the one the code is written
     * in or picked from (null until the first deploy makes it), its name
     * and line as typed, and the params filled (§3), as the form holds
     * them: text as typed, money in LDC.
     */
    judgeId: string | null;
    name: string;
    description: string;
    params: Record<string, unknown>;
    /** Another's 判定器 picked from the 广场 (§15.3); null for one's own. */
    borrowed: BorrowedJudge | null;
  };
  /** Not asked for 代码判定, which its code judges. */
  participation: "password" | "direct";
  passwords: string[];
  /**
   * 首页领取 off (07 §6): its 口令 match only on its own page, and it joins
   * 红包广场 so it can be found. Every 口令红包 counts attempts anyway.
   */
  pageOnly: boolean;
  /** When it closes (or, for a timed draw, the latest draw time). */
  timing: {
    kind: "duration" | "at";
    value: string;
    unit: TimeUnit;
    /** datetime-local value. */
    at: string;
  };
  beforeInfo: string;
  afterClaimInfo: string;
  afterEndInfo: string;
  topic: string;
  /** 附带网页 (docs/attached-page-design.md): an https page; empty for none. */
  page: string;
  /** Opened as the 红包 page is entered (§2.7). */
  pageAutoOpen: boolean;
  listed: boolean;
  quantity: "exact" | "fuzzy";
  /** 领取前人机验证: Turnstile in a dialog before each claim or sign-up. */
  humanCheck: boolean;
  /** 领取范围 (docs/claim-scope-design.md): everyone, or by 等级 and/or by name. */
  scope: ScopeForm;
};

/** Someone added to 指定的人: their face once found (the server notes their ID). */
/**
 * Another's 判定器 in a draft (docs/judge-square-design.md §15.3, §15.4):
 * its version, whose it is and how it stands, what that version declares,
 * and the 联网 addresses its sender confirmed. Its code is public; its
 * tests are never here.
 */
export type BorrowedJudge = {
  n: number;
  source: Omit<JudgeSource, "declarations" | "network">;
  declarations: JudgeDeclarations | null;
  network: string[] | null;
  networkAck: string[] | null;
};

export type ScopePerson = {
  username: string;
  displayName?: string;
  avatarUrl?: string | null;
  /** Found here when added: false shows they will be known by name. */
  known?: boolean;
};

export type ScopeForm = {
  limited: boolean;
  /** The 信任等级 picked, low to high; none: not by level. */
  levels: number[];
  users: ScopePerson[];
};

export const modeLabels: Record<RewardMode, string> = {
  fixed: "固定均分",
  random: "拼手气",
  custom: "自定义金额",
  timed_draw: "限时开奖",
  code: "代码判定",
};

export const unitLabels: Record<TimeUnit, string> = {
  seconds: "秒",
  minutes: "分钟",
  hours: "小时",
  days: "天",
};

const unitMs: Record<TimeUnit, number> = {
  seconds: 1_000,
  minutes: 60_000,
  hours: 3_600_000,
  days: 86_400_000,
};

function localInput(at: number) {
  const date = new Date(at - new Date(at).getTimezoneOffset() * 60_000);
  return date.toISOString().slice(0, 16);
}

/** A new 红包: 拼手气, empty amounts, one empty 口令, open for 24 hours. */
export function emptyForm(now = Date.now()): FormState {
  return {
    title: "",
    funding: "merchant",
    mode: "random",
    fixed: { unit: "", count: "" },
    random: { total: "", count: "", algorithm: "double_mean" },
    custom: { lines: "", order: "sequential" },
    draw: {
      pool: "",
      winners: "",
      limit: "",
      algorithm: "double_mean",
      fillPool: true,
    },
    judge: {
      total: "",
      count: "",
      minEach: "0.01",
      prompt: "",
      code: "",
      tests: "",
      versions: noVersions(),
      judgeId: null,
      name: "",
      description: "",
      params: {},
      borrowed: null,
    },
    participation: "password",
    passwords: [""],
    pageOnly: false,
    timing: {
      kind: "duration",
      value: "24",
      unit: "hours",
      at: localInput(now + unitMs.days),
    },
    beforeInfo: "",
    afterClaimInfo: "",
    afterEndInfo: "",
    topic: "",
    page: "",
    pageAutoOpen: false,
    listed: false,
    humanCheck: false,
    quantity: "exact",
    scope: {
      limited: false,
      levels: [],
      users: [],
    },
  };
}

/** The 领取范围 as saved, or none (everyone). */
export function scopeInputOf(form: FormState): ClaimScope | undefined {
  const { scope } = form;
  if (!scope.limited || (scope.levels.length === 0 && scope.users.length === 0))
    return undefined;
  return {
    ...(scope.levels.length > 0 ? { levels: scope.levels } : {}),
    ...(scope.users.length > 0
      ? {
          users: scope.users.map((user) => ({
            username: user.username,
            linuxDoId: null,
          })),
        }
      : {}),
  };
}

/** A timed draw's default: the latest draw 180 seconds after opening. */
export function drawTiming(form: FormState): FormState["timing"] {
  return {
    ...form.timing,
    kind: "duration",
    value: String(DEFAULT_DRAW_COUNTDOWN_SECONDS),
    unit: "seconds",
  };
}

/** Another 玩法: a timed draw counts to its draw time, the others to a deadline. */
export function withMode(form: FormState, mode: RewardMode): FormState {
  if (mode === form.mode) return form;
  return {
    ...form,
    mode,
    timing:
      mode === "timed_draw"
        ? drawTiming(form)
        : form.mode === "timed_draw"
          ? emptyForm().timing
          : form.timing,
  };
}

// ── Amounts ───────────────────────────────────────────────────────────

const amountPattern = /^(0|[1-9]\d{0,13})(\.\d{1,2})?$/;

/** An LDC amount in cents, or null when it is not a valid positive amount. */
export function cents(value: string): number | null {
  const text = value.trim();
  if (!amountPattern.test(text)) return null;
  const [whole = "0", fraction = ""] = text.split(".");
  const result = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  return result > 0 && Number.isSafeInteger(result) ? result : null;
}

export const ldc = (value: number) => (value / 100).toFixed(2);

/** 报名上限: any positive whole number (contracts set no other cap). */
function positiveInteger(value: string) {
  const text = value.trim();
  return (
    /^\d+$/.test(text) &&
    Number(text) >= 1 &&
    Number.isSafeInteger(Number(text))
  );
}

export function count(value: string) {
  const text = value.trim();
  if (!/^\d+$/.test(text)) return null;
  const result = Number(text);
  return result >= 1 && result <= LIMITS.shares ? result : null;
}

export function customLines(form: FormState) {
  return form.custom.lines
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

/** The pool and the number of shares (or winners), when they are valid. */
export function plan(form: FormState) {
  switch (form.mode) {
    case "fixed": {
      const unit = cents(form.fixed.unit);
      const shares = count(form.fixed.count);
      return {
        total: unit !== null && shares !== null ? unit * shares : null,
        shares,
        unit,
      };
    }
    case "random":
      return {
        total: cents(form.random.total),
        shares: count(form.random.count),
        unit: null,
      };
    case "custom": {
      const lines = customLines(form).map(cents);
      const valid = lines.length > 0 && lines.every((line) => line !== null);
      return {
        total: valid
          ? lines.reduce<number>((sum, line) => sum + (line ?? 0), 0)
          : null,
        shares: lines.length || null,
        unit: null,
      };
    }
    case "timed_draw":
      return {
        total: cents(form.draw.pool),
        shares: count(form.draw.winners),
        unit: null,
      };
    case "code":
      return {
        total: cents(form.judge.total),
        shares: count(form.judge.count),
        unit: null,
      };
  }
}

/**
 * The range one 拼手气 share can take, in cents, as production states it:
 * fixed only for 均值上下 50% (contracts' boundedMeanLimits). 二倍均值
 * draws each share from what is left, so it has no fixed range — except
 * a single share, which is the whole amount.
 */
export function randomRange(
  total: number,
  shares: number,
  algorithm: Algorithm,
): [number, number] | null {
  if (shares === 1) return [total, total];
  if (algorithm !== "bounded_mean") return null;
  const { min, max } = boundedMeanLimits(total, shares);
  return [min, max];
}

// ── Title ─────────────────────────────────────────────────────────────

/**
 * The title a 红包 gets when none is typed: what it is and how many. Not
 * "<name>的红包": the cover says that already, above the title.
 */
export function defaultTitle(form: FormState) {
  const { shares } = plan(form);
  switch (form.mode) {
    case "random":
      return shares ? `拼手气红包 · ${shares} 份` : "拼手气红包";
    case "fixed":
      return shares ? `均分红包 · ${shares} 份` : "均分红包";
    case "custom":
      return shares ? `红包 · ${shares} 份` : "红包";
    case "timed_draw":
      return shares ? `限时开奖 · ${shares} 个名额` : "限时开奖";
    case "code":
      return shares ? `代码判定 · ${shares} 份` : "代码判定";
  }
}

/** The form as it is sent: an empty title becomes the default one. */
export function withDefaultTitle(form: FormState): FormState {
  return form.title.trim() ? form : { ...form, title: defaultTitle(form) };
}

// ── Topic links ───────────────────────────────────────────────────────

/**
 * A LINUX DO topic or reply link, by production's rules (with or without a
 * slug, reply number optional), as https://linux.do/t/<topic>/<post>.
 */
export function normalizeTopic(raw: string) {
  const text = raw.trim();
  if (!text) return { ok: true as const, value: "" };
  const link = normalizeTopicLink(
    /^https?:\/\//iu.test(text) ? text : `https://${text}`,
  );
  if (!link) return { ok: false as const, value: text };
  return {
    ok: true as const,
    value: link.topicUrl,
    topicId: link.topicId,
    postNumber: link.postNumber,
  };
}

// ── Checks ────────────────────────────────────────────────────────────

export type Issue = { field: string; message: string };

const bytes = (value: string) => new TextEncoder().encode(value).byteLength;

/** Every problem, in form order. `field` is the id of the control. */
/**
 * A 口令's problem as the form says it. The form has no red marks: its fix
 * for unusable characters is the 优化 button beside the field.
 */
function passwordProblem({
  invalidCount,
  length,
}: ReturnType<typeof inspectPassword>) {
  if (invalidCount > 0)
    return `有 ${invalidCount} 个不能用的字符，点「优化」去掉`;
  if (length < 6) return `还差 ${6 - length} 个字，至少 6 个字`;
  return `现在有 ${length} 个字，最多 ${ACTIVITY_LIMITS.passwordMaxCharacters} 个字`;
}

export function issuesOf(form: FormState, now = Date.now()): Issue[] {
  const issues: Issue[] = [];
  const add = (field: string, message: string) =>
    issues.push({ field, message });
  const title = form.title.trim();
  if (!title) add("hb-title", "请填写红包标题");
  else if (Array.from(title).length > LIMITS.title)
    add("hb-title", `标题最多 ${LIMITS.title} 个字`);

  const { total, shares } = plan(form);
  switch (form.mode) {
    case "fixed":
      if (cents(form.fixed.unit) === null)
        add("hb-fixed-unit", "每份金额要大于 0，最多两位小数");
      if (count(form.fixed.count) === null)
        add(
          "hb-fixed-count",
          `份数要在 1 到 ${LIMITS.shares.toLocaleString("en")} 之间`,
        );
      break;
    case "random":
      if (cents(form.random.total) === null)
        add("hb-random-total", "总额要大于 0，最多两位小数");
      if (count(form.random.count) === null)
        add(
          "hb-random-count",
          `份数要在 1 到 ${LIMITS.shares.toLocaleString("en")} 之间`,
        );
      else if (total !== null && shares !== null && total < shares)
        add("hb-random-total", "总额不够分：每份至少 0.01 LDC");
      break;
    case "custom": {
      const lines = customLines(form);
      if (lines.length === 0) add("hb-custom-lines", "至少填写一份金额");
      else if (lines.length > LIMITS.shares)
        add("hb-custom-lines", `最多 ${LIMITS.shares.toLocaleString("en")} 份`);
      else {
        const bad = lines.findIndex((line) => cents(line) === null);
        if (bad >= 0)
          add(
            "hb-custom-lines",
            `第 ${bad + 1} 行不是有效金额（大于 0，最多两位小数）`,
          );
      }
      break;
    }
    case "timed_draw":
      if (cents(form.draw.pool) === null)
        add("hb-draw-pool", "奖池要大于 0，最多两位小数");
      if (count(form.draw.winners) === null)
        add(
          "hb-draw-winners",
          `获奖名额要在 1 到 ${LIMITS.shares.toLocaleString("en")} 之间`,
        );
      else if (total !== null && shares !== null && total < shares)
        add("hb-draw-pool", "奖池不够分：每个名额至少 0.01 LDC");
      if (form.draw.limit.trim() && !positiveInteger(form.draw.limit))
        add("hb-draw-limit", "报名上限要是正整数，或者留空不限");
      break;
    case "code": {
      const minEach = cents(form.judge.minEach);
      if (total === null) add("hb-code-total", "总奖池要大于 0，最多两位小数");
      if (shares === null)
        add(
          "hb-code-count",
          `份数要在 1 到 ${LIMITS.shares.toLocaleString("en")} 之间`,
        );
      if (minEach === null)
        add("hb-code-min", "每份至少要大于 0，最多两位小数");
      else if (total !== null && shares !== null && total < minEach * shares)
        add(
          "hb-code-total",
          `总奖池不够：${shares} 份每份至少 ${ldc(minEach)}，要 ${ldc(minEach * shares)} LDC`,
        );
      if (
        Array.from(form.judge.prompt.trim()).length >
        JUDGE_LIMITS.promptCharacters
      )
        add(
          "hb-code-prompt",
          `领取时的提示最多 ${JUDGE_LIMITS.promptCharacters} 个字`,
        );
      if (Array.from(form.judge.name.trim()).length > JUDGE_NAME_LIMITS.name)
        add("hb-judge-name", `名字最多 ${JUDGE_NAME_LIMITS.name} 个字`);
      if (
        Array.from(form.judge.description.trim()).length >
        JUDGE_NAME_LIMITS.description
      )
        add(
          "hb-judge-description",
          `说明最多 ${JUDGE_NAME_LIMITS.description} 个字`,
        );
      if (!form.judge.code.trim()) add("hb-code-code", "先挑一个判定器");
      else if (bytes(form.judge.code) > JUDGE_LIMITS.codeBytes)
        add("hb-code-code", `代码超过 ${JUDGE_LIMITS.codeBytes / 1024} KB`);
      if (bytes(form.judge.tests) > JUDGE_LIMITS.testsBytes)
        add("hb-code-tests", `测试超过 ${JUDGE_LIMITS.testsBytes / 1024} KB`);
      break;
    }
  }

  if (form.mode !== "code" && form.participation === "password") {
    const filled = form.passwords.map((item) => item.trim());
    if (filled.every((item) => !item)) add("hb-password-0", "至少填写一个口令");
    filled.forEach((item, index) => {
      if (!item) return;
      const inspection = inspectPassword(item);
      if (!inspection.valid)
        add(
          `hb-password-${index}`,
          `口令 ${index + 1}：${passwordProblem(inspection)}`,
        );
      else if (filled.indexOf(item) !== index)
        add(`hb-password-${index}`, `口令 ${index + 1} 和前面的重复了`);
    });
  }

  if (form.timing.kind === "duration") {
    const value = Number(form.timing.value);
    if (!/^\d+$/.test(form.timing.value.trim()) || value < 1)
      add("hb-timing-value", "时长要是正整数");
  } else {
    const at = new Date(form.timing.at).getTime();
    if (!Number.isFinite(at) || at <= now)
      add(
        "hb-timing-at",
        form.mode === "timed_draw"
          ? "开奖时间要晚于现在"
          : "截止时间要晚于现在",
      );
  }

  for (const [field, label, text] of [
    ["hb-before-info", "红包说明", form.beforeInfo],
    ["hb-after-claim-info", "领取后附言", form.afterClaimInfo],
    ["hb-after-end-info", "结束说明", form.afterEndInfo],
  ] as const)
    if (Array.from(text).length > LIMITS.info)
      add(field, `${label}最多 ${LIMITS.info.toLocaleString("en")} 个字`);

  if (!normalizeTopic(form.topic).ok)
    add("hb-topic", "请填写 LINUX DO 帖子或回复的链接");
  const pageProblem = pageUrlProblem(form.page);
  if (pageProblem) add("hb-page", pageProblem);

  const { scope } = form;
  if (scope.limited) {
    if (scope.levels.length === 0 && scope.users.length === 0)
      add("hb-scope", "至少选一项：指定的人，或按等级");
    else if (scope.levels.length === TRUST_LEVEL_MAX - TRUST_LEVEL_MIN + 1)
      add("hb-scope-levels", "等级全选就等于所有人");
    if (scope.users.length > CLAIM_SCOPE_LIMITS.users)
      add("hb-scope-user", `最多指定 ${CLAIM_SCOPE_LIMITS.users} 人`);
  }
  return issues;
}

/** How long it stays open, in ms from the moment it opens. */
export function durationMs(form: FormState, now = Date.now()) {
  if (form.timing.kind === "at")
    return new Date(form.timing.at).getTime() - now;
  return Number(form.timing.value) * unitMs[form.timing.unit];
}

/** "24 小时后截止" / "10月16日 20:00 截止" for the summary. */
export function timingLine(form: FormState) {
  const draw = form.mode === "timed_draw";
  if (form.timing.kind === "at") {
    const at = new Date(form.timing.at);
    if (Number.isNaN(at.getTime()))
      return draw ? "开奖时间未定" : "截止时间未定";
    const pad = (value: number) => String(value).padStart(2, "0");
    return `${at.getMonth() + 1}月${at.getDate()}日 ${pad(at.getHours())}:${pad(at.getMinutes())} ${draw ? "最晚开奖" : "截止"}`;
  }
  const value = form.timing.value.trim() || "?";
  return `开放后 ${value} ${unitLabels[form.timing.unit]}${draw ? "内开奖" : "截止"}`;
}

/** One line for lists: "固定均分 · 1.00 LDC / 份", "限时开奖 · 5.00 LDC 奖池". */
export function rewardSummaryOf(form: FormState) {
  const { total, unit } = plan(form);
  if (form.mode === "fixed")
    return `固定均分 · ${unit !== null ? ldc(unit) : "—"} LDC / 份`;
  return `${modeLabels[form.mode]} · ${total !== null ? ldc(total) : "—"} LDC 奖池`;
}

// ── Production ────────────────────────────────────────────────────────

const unitSeconds: Record<TimeUnit, number> = {
  seconds: 1,
  minutes: 60,
  hours: 3_600,
  days: 86_400,
};

/** A length of time in the largest whole unit (a timed draw's countdown). */
function timingOfSeconds(seconds: number, base: FormState["timing"]) {
  const { value, unit } = durationOfSeconds(seconds);
  return { ...base, kind: "duration" as const, value: String(value), unit };
}

const algorithmOf = (value: "double_mean_v1" | "bounded_mean_v1"): Algorithm =>
  value === "bounded_mean_v1" ? "bounded_mean" : "double_mean";

const participationOf = (
  mode: ActivityInput["participationMode"],
): FormState["participation"] => (mode === "direct" ? "direct" : "password");

/** A saved 红包 back into the form (📝 编辑). */
/** Another's 判定器 as a saved draft has it (§15.4), else null. */
function borrowedOf(activity: ManagedActivity): BorrowedJudge | null {
  const version = activity.config.judge?.version;
  const source = activity.judgeSource;
  if (version === undefined || !source) return null;
  const { declarations, network, ...rest } = source;
  return {
    n: version,
    source: rest,
    declarations,
    network,
    networkAck: activity.config.judge?.networkAck ?? null,
  };
}

export function formOf(activity: ManagedActivity, now = Date.now()): FormState {
  const base = emptyForm(now);
  const config = activity.config;
  const money = config.money;
  const deadline = config.deadline;
  const timing: FormState["timing"] =
    deadline.mode === "at"
      ? { ...base.timing, kind: "at", at: localInput(Date.parse(deadline.at)) }
      : "value" in deadline
        ? {
            ...base.timing,
            kind: "duration",
            value: String(deadline.value),
            unit: deadline.unit,
          }
        : money.mode === "timed_draw" && money.countdownSeconds
          ? timingOfSeconds(money.countdownSeconds, base.timing)
          : money.mode === "timed_draw"
            ? drawTiming(base)
            : base.timing;
  const unit =
    money.mode === "fixed"
      ? ldc(amountToMinor(money.totalAmount) / money.count)
      : "";
  return {
    ...base,
    title: config.title,
    funding: config.funding ?? "merchant",
    mode: money.mode,
    fixed:
      money.mode === "fixed"
        ? { unit, count: String(money.count) }
        : base.fixed,
    random:
      money.mode === "random"
        ? {
            total: money.totalAmount,
            count: String(money.count),
            algorithm: algorithmOf(money.algorithm),
          }
        : base.random,
    custom:
      money.mode === "custom"
        ? {
            lines: money.amounts.join("\n"),
            order: config.allocation,
          }
        : base.custom,
    draw:
      money.mode === "timed_draw"
        ? {
            pool: money.totalAmount,
            winners: String(money.count),
            limit: money.participantLimit ? String(money.participantLimit) : "",
            algorithm: algorithmOf(money.algorithm),
            fillPool: money.distributeFullPool,
          }
        : base.draw,
    judge:
      money.mode === "code"
        ? {
            total: money.totalAmount,
            count:
              money.count === undefined
                ? base.judge.count
                : String(money.count),
            minEach: money.minEach ?? base.judge.minEach,
            prompt: config.judge?.prompt ?? "",
            code: config.judge?.code ?? "",
            tests: config.judge?.tests ?? "",
            versions: config.judge?.versions ?? noVersions(),
            judgeId: config.judge?.judgeId ?? null,
            name: config.judge?.name ?? "",
            description: config.judge?.description ?? "",
            params: config.judge?.params ?? {},
            borrowed: borrowedOf(activity),
          }
        : base.judge,
    participation: participationOf(
      activity.participationMode ?? config.participationMode,
    ),
    passwords: config.passwords.length > 0 ? [...config.passwords] : [""],
    pageOnly: config.forceDedicated,
    timing,
    beforeInfo: config.beforeInfo,
    afterClaimInfo: config.afterClaimInfo,
    afterEndInfo: config.afterEndInfo,
    topic: config.topicUrl,
    page: config.pageUrl ?? "",
    pageAutoOpen: config.pageAutoOpen === true,
    listed: config.joinSquare,
    quantity: config.quantityVisibility === "fuzzy" ? "fuzzy" : "exact",
    humanCheck: config.humanCheck === true,
    scope: config.scope
      ? {
          limited: true,
          levels: config.scope.levels ?? [],
          users: (config.scope.users ?? []).map((user) => ({
            username: user.username,
            known: user.linuxDoId !== null,
          })),
        }
      : base.scope,
  };
}

/**
 * The form as production saves it, paid by `merchantId` (none for a
 * 🐟额红包). Checked first.
 */
export function inputOf(form: FormState, merchantId: string): ActivityInput {
  const { total, shares, unit } = plan(form);
  const pool = ldc(total ?? 0);
  const count = shares ?? 1;
  const algorithm = (value: Algorithm) =>
    value === "bounded_mean" ? "bounded_mean_v1" : "double_mean_v1";
  const draw = form.mode === "timed_draw";
  // A timed draw counts down to its latest draw time; the others close.
  const countdown =
    draw && form.timing.kind === "duration"
      ? Number(form.timing.value) * unitSeconds[form.timing.unit]
      : undefined;
  const money: LdcMoney =
    form.mode === "fixed"
      ? { mode: "fixed", totalAmount: ldc((unit ?? 0) * count), count }
      : form.mode === "random"
        ? {
            mode: "random",
            algorithm: algorithm(form.random.algorithm),
            totalAmount: pool,
            count,
          }
        : form.mode === "custom"
          ? {
              mode: "custom",
              amounts: customLines(form).map((line) => ldc(cents(line) ?? 0)),
            }
          : form.mode === "code"
            ? {
                mode: "code",
                totalAmount: pool,
                count,
                minEach: ldc(cents(form.judge.minEach) ?? 0),
              }
            : {
                mode: "timed_draw",
                algorithm: algorithm(form.draw.algorithm),
                totalAmount: pool,
                count,
                participantLimit: form.draw.limit.trim()
                  ? Number(form.draw.limit)
                  : null,
                distributeFullPool: form.draw.fillPool,
                ...(countdown ? { countdownSeconds: countdown } : {}),
              };
  const deadline: ActivityInput["deadline"] =
    form.timing.kind === "at"
      ? { mode: "at", at: new Date(form.timing.at).toISOString() }
      : draw
        ? { mode: "duration" }
        : form.timing.unit === "seconds"
          ? // Never offered for a deadline; were it there, a whole minute.
            {
              mode: "duration",
              value: Math.ceil(Number(form.timing.value) / 60),
              unit: "minutes",
            }
          : {
              mode: "duration",
              value: Number(form.timing.value),
              unit: form.timing.unit,
            };
  const coded = form.mode === "code";
  const password = !coded && form.participation === "password";
  // 代码判定红包只能在红包页领，自动加入红包广场 (07 §5).
  const pageOnly = coded || (password && form.pageOnly);
  return {
    title: form.title.trim(),
    topicUrl: normalizeTopic(form.topic).value,
    forceDedicated: pageOnly,
    joinSquare: form.listed || pageOnly,
    deadline,
    allocation:
      form.mode === "random" || draw
        ? "random"
        : form.mode === "custom"
          ? form.custom.order
          : "sequential",
    passwords: password
      ? form.passwords.map((item) => item.trim()).filter(Boolean)
      : [],
    quantityVisibility: form.quantity,
    beforeInfo: form.beforeInfo,
    afterClaimInfo: form.afterClaimInfo,
    afterEndInfo: form.afterEndInfo,
    participationMode: coded ? "code" : form.participation,
    // Left out when off, so older saved forms keep their shape (idempotency).
    ...(form.humanCheck ? { humanCheck: true } : {}),
    ...(normalizePageUrl(form.page)
      ? {
          pageUrl: normalizePageUrl(form.page) ?? "",
          ...(form.pageAutoOpen ? { pageAutoOpen: true } : {}),
        }
      : {}),
    ...(scopeInputOf(form) ? { scope: scopeInputOf(form) } : {}),
    rewardType: "ldc",
    // Left out for 商户直发, as before 🐟额红包 (idempotency).
    ...(form.funding === "balance"
      ? { funding: "balance" as const, merchantId: "" }
      : { merchantId }),
    money,
    ...(coded
      ? {
          // Its versions are its 判定器's: never sent. Another's is its
          // version: its code and tests are the server's to put in.
          judge: {
            prompt: form.judge.prompt.trim(),
            code: form.judge.code,
            tests: form.judge.borrowed ? "" : form.judge.tests,
            ...(form.judge.judgeId && form.judge.borrowed
              ? {
                  judgeId: form.judge.judgeId,
                  version: form.judge.borrowed.n,
                  ...(form.judge.borrowed.networkAck
                    ? { networkAck: form.judge.borrowed.networkAck }
                    : {}),
                }
              : form.judge.judgeId
                ? {
                    judgeId: form.judge.judgeId,
                    name: form.judge.name.trim(),
                    description: form.judge.description.trim(),
                  }
                : {}),
            ...(Object.keys(form.judge.params).length > 0
              ? { params: form.judge.params }
              : {}),
          },
        }
      : {}),
  };
}

/**
 * An opened 红包's input with this form's edits: after opening only its
 * words, the post link, 加入广场, how quantities show and 领取前人机验证
 * may change, so everything else (附带网页 among it) is sent back as it
 * was saved.
 */
export function openedInputOf(
  activity: ManagedActivity,
  form: FormState,
): ActivityInput {
  return {
    ...activity.config,
    title: form.title.trim(),
    topicUrl: normalizeTopic(form.topic).value,
    joinSquare: form.listed,
    quantityVisibility: form.quantity,
    beforeInfo: form.beforeInfo,
    afterClaimInfo: form.afterClaimInfo,
    afterEndInfo: form.afterEndInfo,
    humanCheck: form.humanCheck,
  };
}

/** Whether a saved 红包 holds what was sent (a 409 after a lost answer). */
export function sameInput(saved: ActivityInput, sent: ActivityInput) {
  const { money: savedMoney, ...savedRest } = saved;
  const { money: sentMoney, ...sentRest } = sent;
  const comparable = (input: Omit<ActivityInput, "money">) =>
    JSON.stringify({
      title: input.title.trim(),
      topicUrl: input.topicUrl,
      forceDedicated: input.forceDedicated,
      joinSquare: input.joinSquare,
      deadline: input.deadline,
      allocation: input.allocation,
      passwords: input.passwords,
      quantityVisibility: input.quantityVisibility,
      beforeInfo: input.beforeInfo,
      afterClaimInfo: input.afterClaimInfo,
      afterEndInfo: input.afterEndInfo,
      merchantId: input.merchantId,
      funding: input.funding ?? "merchant",
      humanCheck: input.humanCheck === true,
      pageUrl: input.pageUrl ?? "",
      pageAutoOpen: input.pageUrl ? input.pageAutoOpen === true : false,
      // What a save sends of its code (its versions come back with it).
      judge: input.judge
        ? {
            prompt: input.judge.prompt.trim(),
            code: input.judge.code,
            tests: input.judge.tests,
            judgeId: input.judge.judgeId ?? null,
            version: input.judge.version ?? null,
            networkAck: input.judge.networkAck ?? null,
            params: input.judge.params ?? null,
          }
        : null,
      scope: input.scope
        ? {
            levels: input.scope.levels ?? null,
            users: (input.scope.users ?? [])
              .map((user) => user.username.toLowerCase())
              .sort(),
          }
        : null,
    });
  return (
    comparable(savedRest) === comparable(sentRest) &&
    sameLdcMoney(savedMoney, sentMoney)
  );
}

/**
 * A picked 判定器's `hongbao` (docs/judge-square-design.md §4): its
 * defaults on whatever is still as a new form has it — the amounts left
 * empty, 24 hours to the deadline, no prompt — and 领取前人机验证 on when
 * it suggests it.
 */
export function withJudgeDefaults(
  form: FormState,
  rules: JudgeHongbaoRules | null | undefined,
): FormState {
  if (!rules) return form;
  const blank = (value: string) => value.trim() === "";
  const judge = { ...form.judge };
  if (rules.count?.default !== undefined && blank(judge.count))
    judge.count = String(rules.count.default);
  if (rules.total?.default !== undefined && blank(judge.total))
    judge.total = ldc(rules.total.default);
  if (
    rules.minEach?.default !== undefined &&
    (blank(judge.minEach) || judge.minEach === "0.01")
  )
    judge.minEach = ldc(rules.minEach.default);
  if (rules.prompt !== undefined && blank(judge.prompt))
    judge.prompt = rules.prompt;
  const untouched =
    form.timing.kind === "duration" &&
    form.timing.value === "24" &&
    form.timing.unit === "hours";
  return {
    ...form,
    judge,
    ...(rules.deadline && untouched
      ? {
          timing: {
            ...form.timing,
            value: String(rules.deadline.value),
            unit: rules.deadline.unit,
          },
        }
      : {}),
    ...(rules.humanCheck ? { humanCheck: true } : {}),
  };
}
