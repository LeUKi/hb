import { boundedMeanLimits, normalizeTopicLink } from "@hb/contracts";
import {
  activities,
  type FixtureActivity,
  findActivity,
  openedAtOf,
  pageLoadedAt,
  registerActivity,
  unregisterActivity,
} from "../../fixtures/activities";
import { merchantOfActivity } from "../../fixtures/merchants";
import { inspectPassword } from "../../lib/password-rules";

// The 发红包 flow (/new) and the sender's 📝 编辑: one state shape, its
// checks, and the conversion to and from the prototype's fixtures. Limits
// follow production's contracts (ACTIVITY_LIMITS, LDC amounts);
// docs/redesign/07 §5 has the reasoning.

export const LIMITS = {
  title: 100,
  passwords: 5,
  shares: 1000,
  info: 10_000,
} as const;

export type RewardMode = FixtureActivity["mode"];
export type Algorithm = "double_mean" | "bounded_mean";
export type TimeUnit = "minutes" | "hours" | "days";

export type FormState = {
  title: string;
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
  participation: "password" | "direct";
  passwords: string[];
  /** 口令尝试统计: passwords only on the 红包 page, attempts recorded. */
  statistics: boolean;
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
  listed: boolean;
  quantity: "exact" | "fuzzy";
};

export const modeLabels: Record<RewardMode, string> = {
  fixed: "固定均分",
  random: "拼手气",
  custom: "自定义金额",
  timed_draw: "限时开奖",
};

export const unitLabels: Record<TimeUnit, string> = {
  minutes: "分钟",
  hours: "小时",
  days: "天",
};

const unitMs: Record<TimeUnit, number> = {
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
    participation: "password",
    passwords: [""],
    statistics: false,
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
    listed: false,
    quantity: "exact",
  };
}

/** A timed draw's default: the latest draw 10 minutes after opening. */
export function drawTiming(form: FormState): FormState["timing"] {
  return { ...form.timing, kind: "duration", value: "10", unit: "minutes" };
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

function count(value: string) {
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
  return `现在有 ${length} 个字，最多 18 个字`;
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
  }

  if (form.participation === "password") {
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

// ── Fixtures ──────────────────────────────────────────────────────────

/** A 红包 back into the form (📝 编辑). */
export function formOf(activity: FixtureActivity, now = Date.now()): FormState {
  const base = emptyForm(now);
  const shares = String(activity.shares);
  const deadline =
    pageLoadedAt + activity.deadlineMinutes * 60_000 - openedAtOf(activity);
  const days = deadline / unitMs.days;
  const hours = deadline / unitMs.hours;
  const timing: FormState["timing"] = activity.draftTiming
    ? { ...activity.draftTiming }
    : activity.deadlineClock || deadline <= 0
      ? {
          ...base.timing,
          kind: "at",
          at: localInput(pageLoadedAt + activity.deadlineMinutes * 60_000),
        }
      : Number.isInteger(days)
        ? { ...base.timing, value: String(days), unit: "days" }
        : Number.isInteger(hours)
          ? { ...base.timing, value: String(hours), unit: "hours" }
          : {
              ...base.timing,
              value: String(Math.round(deadline / unitMs.minutes)),
              unit: "minutes",
            };
  return {
    ...base,
    title: activity.title,
    mode: activity.mode,
    fixed:
      activity.mode === "fixed"
        ? { unit: activity.unitAmount ?? "", count: shares }
        : base.fixed,
    random:
      activity.mode === "random"
        ? {
            total: activity.totalAmount,
            count: shares,
            algorithm: activity.algorithm ?? "double_mean",
          }
        : base.random,
    custom:
      activity.mode === "custom"
        ? {
            lines: (activity.custom?.lines ?? []).join("\n"),
            order: activity.custom?.allocation ?? "sequential",
          }
        : base.custom,
    draw:
      activity.mode === "timed_draw"
        ? {
            pool: activity.totalAmount,
            winners: shares,
            limit: activity.participantLimit
              ? String(activity.participantLimit)
              : "",
            algorithm: activity.algorithm ?? "double_mean",
            fillPool: activity.fillPool ?? true,
          }
        : base.draw,
    participation: activity.participation,
    passwords: activity.passwords.length > 0 ? [...activity.passwords] : [""],
    statistics: Boolean(activity.statistics),
    timing,
    beforeInfo: activity.beforeInfo ?? "",
    afterClaimInfo: activity.afterClaimInfo ?? "",
    afterEndInfo: activity.afterEndInfo ?? "",
    topic: activity.topic
      ? `https://linux.do/t/${activity.topic.topicId}/${activity.topic.postNumber}`
      : "",
    listed: activity.listed !== false,
    quantity: activity.quantity,
  };
}

/** The amounts a 拼手气 hands out, pre-drawn (as production does on save). */
function randomAmounts(total: number, shares: number, algorithm: Algorithm) {
  const out: number[] = [];
  let left = total;
  for (let index = shares; index > 0; index--) {
    if (index === 1) {
      out.push(left);
      break;
    }
    // 二倍均值: up to twice the mean of what is left (production's rule).
    const [low, high] = randomRange(left, index, algorithm) ?? [
      1,
      Math.max(1, Math.floor((left * 2) / index) - 1),
    ];
    const cap = left - (index - 1);
    const value = Math.min(
      cap,
      low + Math.floor(Math.random() * (high - low + 1)),
    );
    out.push(Math.max(1, value));
    left -= Math.max(1, value);
  }
  return out;
}

/**
 * The form as a 红包 in the prototype's data: saved as a 草稿, or opened
 * right now. Pass `existing` to update one in place.
 */
export function saveAsFixture(
  form: FormState,
  author: FixtureActivity["author"],
  options: {
    open: boolean;
    existing?: FixtureActivity;
    /** The current merchant: it pays the 红包 from the moment it opens. */
    merchantId?: string;
  },
): FixtureActivity {
  const now = Date.now();
  const { total, shares, unit } = plan(form);
  const pool = total ?? 0;
  const count = shares ?? 1;
  const minutesSinceLoad = (now - pageLoadedAt) / 60_000;
  const topic = normalizeTopic(form.topic);
  const amounts =
    form.mode === "random"
      ? randomAmounts(pool, count, form.random.algorithm).map(ldc)
      : form.mode === "custom"
        ? customLines(form).map((line) => ldc(cents(line) ?? 0))
        : [];
  let next = 0;
  const existing = options.existing;
  const opened = existing && !existing.draft;
  const activity: FixtureActivity = {
    ...(existing ?? {}),
    id: existing?.id ?? crypto.randomUUID(),
    title: form.title.trim(),
    situation: opened
      ? existing.situation
      : options.open
        ? "我发的 · 刚开放"
        : "我发的 · 草稿",
    author: existing?.author ?? author,
    mode: form.mode,
    participation: form.participation,
    // Editing an opened 红包 changes only its words; it keeps its state.
    status: opened ? existing.status : "active",
    rewardSummary: rewardSummaryOf(form),
    totalAmount: ldc(pool),
    unitAmount: unit !== null ? ldc(unit) : undefined,
    shares: count,
    quantity: form.quantity,
    custom:
      form.mode === "custom"
        ? { lines: amounts, allocation: form.custom.order }
        : undefined,
    participantLimit:
      form.mode === "timed_draw" && form.draw.limit.trim()
        ? Number(form.draw.limit)
        : null,
    opened: opened ? existing.opened : -minutesSinceLoad,
    deadlineMinutes: opened
      ? existing.deadlineMinutes
      : (now + durationMs(form, now) - pageLoadedAt) / 60_000,
    deadlineClock: opened ? existing.deadlineClock : undefined,
    // A 草稿 keeps the timing as set; it becomes a deadline on opening.
    draftTiming: options.open ? undefined : { ...form.timing },
    algorithm:
      form.mode === "random"
        ? form.random.algorithm
        : form.mode === "timed_draw"
          ? form.draw.algorithm
          : undefined,
    fillPool: form.mode === "timed_draw" ? form.draw.fillPool : undefined,
    entries: existing?.entries ?? [],
    beforeInfo: form.beforeInfo.trim() || undefined,
    afterClaimInfo: form.afterClaimInfo.trim() || undefined,
    afterEndInfo: form.afterEndInfo.trim() || undefined,
    passwords:
      form.participation === "password"
        ? form.passwords.map((item) => item.trim()).filter(Boolean)
        : [],
    statistics: form.participation === "password" && form.statistics,
    topic:
      topic.ok && "topicId" in topic && topic.topicId
        ? { topicId: topic.topicId, postNumber: topic.postNumber }
        : undefined,
    // Amounts are fixed once it opens; until then they follow the form.
    amount: opened
      ? existing.amount
      : form.mode === "fixed"
        ? () => ldc(unit ?? 0)
        : form.mode === "custom" && form.custom.order === "sequential"
          ? (taken: number) => amounts[taken] ?? amounts.at(-1) ?? "0.00"
          : () => amounts[next++ % Math.max(1, amounts.length)] ?? "0.00",
    listed: form.listed,
    draft: !options.open,
  };
  if (existing) Object.assign(existing, activity);
  else activities.push(activity);
  if (options.open && !opened && options.merchantId)
    merchantOfActivity[activity.id] = options.merchantId;
  registerActivity(existing ?? activity);
  return existing ?? activity;
}

/** Drop a 草稿 (删除草稿). */
export function deleteDraft(activity: FixtureActivity) {
  const index = activities.indexOf(activity);
  if (index >= 0) activities.splice(index, 1);
  unregisterActivity(activity.id);
}

export { findActivity };
