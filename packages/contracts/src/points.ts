// 三方积分 (docs/third-party-points-design.md): another site's points that a
// 红包 can be paid in, through the issuer's three endpoints (§3). Amounts on
// the wire are whole 分 as decimal strings; a system's 最小单位 (step) is in
// 分 too (amount.ts).
import { z } from "zod";
import { type AmountUnit, formatStep, isValidStep, MAX_STEP } from "./amount";
import type { LdcMoney } from "./index";
import { amountToMinor } from "./payments";

export const POINTS_LIMITS = {
  /** Systems one PLUS user may register (§1). */
  systemsPerOwner: 3,
  nameMax: 6,
  unitMax: 4,
  issuerNameMax: 20,
  introMax: 2000,
  keyGuideMax: 2000,
  noRecipientMax: 1000,
  arrivalMax: 60,
  notAllowedMax: 60,
  senderNoticeMax: 100,
  reviewNoteMax: 200,
  keyMax: 512,
  baseUrlMax: 200,
  outTradeNoMax: 64,
  remarkMax: 60,
  /** One answer: 10 s, 64 KB (§3). */
  timeoutMs: 10_000,
  responseBytesMax: 64 * 1024,
  /** Self-tests one system may start: one each 30 s (§4). */
  selfTestCooldownMs: 30_000,
  /** Network retries after no answer: 1, 5 and 30 minutes (§5). */
  retryDelaysMs: [60_000, 5 * 60_000, 30 * 60_000] as const,
  /** 熔断: this many answers missed in a row pause a system this long. */
  breakerMisses: 5,
  breakerPauseMs: 10 * 60_000,
  /** Calls a second the issuer takes, by default and at most (§12). */
  rateDefault: 10,
  rateMax: 100,
} as const;

/** The issuer protocol's version, sent as Hb-Points-Protocol. */
export const POINTS_PROTOCOL = 1;

/** What 发放 may answer (§3). */
export const pointsTransferResultSchema = z.enum([
  "ok",
  "insufficient",
  "no_recipient",
  "not_allowed",
  "key_invalid",
  "bad_request",
  "conflict",
]);
export type PointsTransferResult = z.infer<typeof pointsTransferResultSchema>;

/** A 三方积分's life (§1). */
export const pointsSystemStatusSchema = z.enum([
  "draft",
  "reviewing",
  "online",
  "paused",
  "retired",
]);
export type PointsSystemStatus = z.infer<typeof pointsSystemStatusSchema>;

const count = (value: string) => Array.from(value).length;

const RESERVED = [
  "ldc",
  "credit",
  "🐟",
  "🐟额",
  "鱼额",
  "红包站",
  "红包",
  "linux do",
  "linuxdo",
];

/** A name or unit that would pass for this site's own (§11). */
export function reservedPointsWord(value: string) {
  const plain = value.trim().toLowerCase().replace(/\s+/g, " ");
  return RESERVED.some(
    (word) => plain === word || plain.includes(word.replace(" ", "")),
  );
}

const shortText = (max: number, what: string) =>
  z
    .string()
    .trim()
    .refine((value) => count(value) >= 1, `请填写${what}`)
    .refine((value) => count(value) <= max, `${what}最多 ${max} 个字`)
    .refine((value) => !/[\r\n]/.test(value), `${what}只能写一行`);

const markdown = (max: number, what: string) =>
  z
    .string()
    .trim()
    .refine((value) => count(value) <= max, `${what}最多 ${max} 个字`);

const optionalLine = (max: number, what: string) =>
  z
    .string()
    .trim()
    .refine((value) => count(value) <= max, `${what}最多 ${max} 个字`)
    .refine((value) => !/[\r\n]/.test(value), `${what}只能写一行`);

/**
 * The endpoint base an issuer gives: public https, no credentials, query
 * or fragment, not an IP address, localhost, or this site's own lafi.sh
 * (§11). Normalized without a trailing slash.
 */
export function normalizePointsBaseUrl(
  value: string,
): { ok: true; url: string; host: string } | { ok: false; message: string } {
  const text = value.trim();
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return { ok: false, message: "接口地址不是一个网址" };
  }
  if (url.protocol !== "https:")
    return { ok: false, message: "接口地址要以 https:// 开头" };
  if (url.username || url.password)
    return { ok: false, message: "接口地址里不能带用户名或密码" };
  if (url.search || url.hash)
    return { ok: false, message: "接口地址里不能带 ? 或 # 后面的部分" };
  if (url.port && url.port !== "443")
    return { ok: false, message: "接口地址只能用默认端口" };
  const host = url.hostname.toLowerCase();
  if (
    /^[\d.]+$/.test(host) ||
    host.includes(":") ||
    host.startsWith("[") ||
    !host.includes(".")
  )
    return { ok: false, message: "接口地址要用域名，不能是 IP 地址" };
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    host === "lafi.sh" ||
    host.endsWith(".lafi.sh")
  )
    return { ok: false, message: "接口地址不能指向本机或本站" };
  const path = url.pathname.replace(/\/+$/, "");
  const normalized = `https://${host}${path}`;
  if (count(normalized) > POINTS_LIMITS.baseUrlMax)
    return { ok: false, message: "接口地址太长" };
  return { ok: true, url: normalized, host };
}

export const pointsStepSchema = z
  .number()
  .int()
  .refine(isValidStep, `最小单位要在 0.01 到 ${MAX_STEP / 100} 之间`);

/** What an issuer fills in on the 配置页 (§6), all but the test key. */
export const pointsSystemConfigSchema = z.strictObject({
  name: shortText(POINTS_LIMITS.nameMax, "名称").refine(
    (value) => !reservedPointsWord(value),
    "名称不能用本站自己的说法",
  ),
  unit: shortText(POINTS_LIMITS.unitMax, "单位").refine(
    (value) => !reservedPointsWord(value),
    "单位不能用本站自己的说法",
  ),
  step: pointsStepSchema,
  issuerName: shortText(POINTS_LIMITS.issuerNameMax, "网站名称"),
  /** Checked by normalizePointsBaseUrl (the API lets local dev use http). */
  baseUrl: z.string().trim().min(1, "请填写接口地址").max(400),
  intro: markdown(POINTS_LIMITS.introMax, "介绍"),
  keyGuide: markdown(POINTS_LIMITS.keyGuideMax, "怎么拿到密钥"),
  noRecipient: markdown(
    POINTS_LIMITS.noRecipientMax,
    "领取的人还没开户时的说明",
  ),
  arrival: optionalLine(POINTS_LIMITS.arrivalMax, "到账后的说明"),
  notAllowed: optionalLine(POINTS_LIMITS.notAllowedMax, "不能发给他时的说明"),
  insufficient: optionalLine(POINTS_LIMITS.senderNoticeMax, "余额不够时的说明"),
  keyInvalid: optionalLine(POINTS_LIMITS.senderNoticeMax, "密钥失效时的说明"),
  rate: z
    .number()
    .int()
    .min(1)
    .max(POINTS_LIMITS.rateMax)
    .default(POINTS_LIMITS.rateDefault),
});
export type PointsSystemConfig = z.infer<typeof pointsSystemConfigSchema>;

/** The copy fields an issuer may change without a new self-test (§4). */
export const POINTS_COPY_FIELDS = [
  "name",
  "unit",
  "issuerName",
  "intro",
  "keyGuide",
  "noRecipient",
  "arrival",
  "notAllowed",
  "insufficient",
  "keyInvalid",
  "rate",
] as const;
export type PointsCopyField = (typeof POINTS_COPY_FIELDS)[number];

export const pointsKeySchema = z
  .string()
  .trim()
  .min(1, "请填写密钥")
  .max(POINTS_LIMITS.keyMax, `密钥最多 ${POINTS_LIMITS.keyMax} 个字符`)
  .regex(/^[\x21-\x7e]+$/, "密钥只能是英文字母、数字和符号，不能有空格");

/** What 自检 needs besides the saved config (§4). */
export const pointsSelfTestInputSchema = z.strictObject({
  /** Left out: the key saved by the last self-test. */
  testKey: pointsKeySchema.optional(),
  testRecipientId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
});

/** A 三方积分 as everyone may see it: tag, hint, detail page (§9). */
export type PublicPointsSystem = {
  id: string;
  name: string;
  unit: string;
  step: number;
  issuerName: string;
  /** The endpoint's host: who issues it, as far as this site can tell. */
  host: string;
  status: PointsSystemStatus;
};

/** "红包站 · 新年快乐", cut to 60 characters (§3). */
export function pointsRemark(title: string) {
  return Array.from(`红包站 · ${title.replace(/\s+/g, " ").trim()}`)
    .slice(0, POINTS_LIMITS.remarkMax)
    .join("");
}

/** The fixed words on every detail page (§9). */
export const POINTS_EXPLAINER =
  "三方积分是其他网站的积分，红包站不保管。发红包的人从他在那个网站的账户里出，领到的直接进你在那个网站的账户。积分能做什么、值多少，由那个网站决定，红包站不核对，也不兑换。";

/** The hint on the 三方｜名称 tag (§9). */
export function pointsTagHint(host: string) {
  return `来自 ${host} 的积分，领到后存进你在这个网站的账户。`;
}

/** The line under the claim button (§9). */
export function pointsPrivacyLine(host: string) {
  return `领取时会把你的 LINUX DO 用户名发给 ${host}。`;
}

/**
 * What a 红包's money breaks of its unit's 最小单位 (§2), or null: every
 * amount a whole number of steps, each share at least one. ldcMoneySchema
 * already holds the 0.01 rules; this adds the step's, server and form
 * alike. Step 1 (LDC, 🐟) never has anything to say.
 */
export function moneyStepIssue(money: LdcMoney, unit: AmountUnit) {
  const { step } = unit;
  if (step === 1) return null;
  const least = `${formatStep(step)} ${unit.unit}`;
  const minor = (value: string) => {
    try {
      return amountToMinor(value);
    } catch {
      return null;
    }
  };
  if (money.mode === "custom") {
    for (const amount of money.amounts) {
      const value = minor(amount);
      if (value !== null && value % step !== 0)
        return `每一份都要是 ${least} 的整数倍`;
    }
    return null;
  }
  const total = minor(money.totalAmount);
  if (total === null) return null;
  if (money.mode === "fixed") {
    if (total % (money.count * step) !== 0)
      return `总数要能平分成 ${money.count} 份，每份是 ${least} 的整数倍`;
    return null;
  }
  if (total % step !== 0) return `总数要是 ${least} 的整数倍`;
  if (money.mode === "code") return null;
  if (total / step < money.count)
    return money.mode === "timed_draw"
      ? `总奖池不足，每个获奖名额至少需要 ${least}`
      : `总数不足，每份至少需要 ${least}`;
  return null;
}

/**
 * A 三方积分红包's system as the 红包 shows it (§9): kept in its config,
 * written at each save and at opening, so a list needs no second read.
 */
export const pointsSnapshotSchema = z.strictObject({
  id: z.uuid(),
  name: z.string().min(1).max(20),
  unit: z.string().min(1).max(20),
  step: pointsStepSchema,
  host: z.string().min(1).max(200),
});
export type PointsSnapshot = z.infer<typeof pointsSnapshotSchema>;

/** What a 红包's views carry of its 三方积分, with why it stopped by itself. */
export type ActivityPoints = PointsSnapshot & {
  /** insufficient, key_invalid, key_removed or retired (§5). */
  stop?: string;
};
