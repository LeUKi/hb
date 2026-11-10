// Amounts by unit (docs/third-party-points-design.md §2): every amount is
// whole 分 (0.01); a unit adds its 最小单位 (step, in 分) and its name.
// LDC and 🐟 are the step-1 case, so everything here reads exactly as the
// old two-decimal formatting for them.

/** 最小单位 in 分: 1 (0.01) up to 1 亿 (10,000,000,000 分). */
export const MIN_STEP = 1;
export const MAX_STEP = 10_000_000_000;
/** LDC's and 🐟's 最小单位: 0.01. */
export const LDC_STEP = 1;

export type AmountUnit = {
  /** Written after an amount: "LDC", "🐟", or a 三方积分's unit. */
  unit: string;
  /** 最小单位 in 分. */
  step: number;
};

export const LDC_UNIT: AmountUnit = { unit: "LDC", step: LDC_STEP };
export const FISH_UNIT: AmountUnit = { unit: "🐟", step: LDC_STEP };

export function isValidStep(step: number) {
  return Number.isSafeInteger(step) && step >= MIN_STEP && step <= MAX_STEP;
}

/** How many decimals a unit shows: none when its step is whole, else 1 or 2. */
export function stepDecimals(step: number): 0 | 1 | 2 {
  if (step % 100 === 0) return 0;
  if (step % 10 === 0) return 1;
  return 2;
}

function assertMinor(minor: number) {
  if (!Number.isSafeInteger(minor)) throw new Error("Invalid amount");
}

/** "1234567" → "1,234,567". */
export function groupDigits(whole: string) {
  return whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

function split(minor: number, step: number) {
  assertMinor(minor);
  const sign = minor < 0 ? "-" : "";
  const value = Math.abs(minor);
  const whole = String(Math.floor(value / 100));
  const cents = String(value % 100).padStart(2, "0");
  const decimals = stepDecimals(step);
  // A step-whole unit can still be shown an amount with cents (a wrong
  // old row, a sum): never drop what is there.
  const shown =
    decimals === 2 || cents.slice(decimals) !== "0".repeat(2 - decimals)
      ? cents
      : cents.slice(0, decimals);
  return { sign, whole, fraction: shown };
}

/**
 * The exact amount as plain digits, with the unit's decimals: LDC 2000 →
 * "20.00", a step-100 unit 2000 → "20", a step-10 unit 2050 → "20.5". This
 * is what APIs and the page SDK carry; never shortened.
 */
export function formatUnitAmount(minor: number, step = LDC_STEP) {
  const { sign, whole, fraction } = split(minor, step);
  return fraction ? `${sign}${whole}.${fraction}` : `${sign}${whole}`;
}

/** The same with thousands separators: "1,234,567.50". */
export function formatFullAmount(minor: number, step = LDC_STEP) {
  const { sign, whole, fraction } = split(minor, step);
  const grouped = groupDigits(whole);
  return fraction ? `${sign}${grouped}.${fraction}` : `${sign}${grouped}`;
}

const SHORT_TIERS = [
  // 1 万亿 = 10^12 units = 10^14 分; one decimal is 10^13 分.
  { from: 100_000_000_000_000, tenth: 10_000_000_000_000, name: "万亿" },
  // 1 亿 = 10^10 分; one decimal is 10^9 分.
  { from: 10_000_000_000, tenth: 1_000_000_000, name: "亿" },
  // From 100 万 (10^8 分); one decimal of 万 is 10^5 分.
  { from: 100_000_000, tenth: 100_000, name: "万" },
] as const;

/**
 * For display: under 100 万 the full amount with separators; from there
 * 万, 亿 or 万亿 with one decimal, cut (not rounded, so it never shows more
 * than there is) and without a trailing .0. `short` says whether it was
 * shortened, so the full amount goes in the hint and to screen readers.
 */
export function formatDisplayAmount(minor: number, step = LDC_STEP) {
  assertMinor(minor);
  const value = Math.abs(minor);
  const full = formatFullAmount(minor, step);
  const tier = SHORT_TIERS.find((item) => value >= item.from);
  if (!tier) return { text: full, full, short: false };
  const tenths = Math.floor(value / tier.tenth);
  const whole = groupDigits(String(Math.floor(tenths / 10)));
  const decimal = tenths % 10;
  const sign = minor < 0 ? "-" : "";
  return {
    text: `${sign}${whole}${decimal ? `.${decimal}` : ""}${tier.name}`,
    full,
    short: true,
  };
}

/** "20.5 星星", or "1.2亿 星星" when long. */
export function formatAmountWithUnit(minor: number, unit: AmountUnit) {
  return `${formatDisplayAmount(minor, unit.step).text} ${unit.unit}`;
}

/** 最小单位 as written: 1 → "0.01", 50 → "0.5", 10000 → "100". */
export function formatStep(step: number) {
  return formatUnitAmount(step, step);
}

/**
 * Typed text → 分 for a unit: digits with at most the unit's decimals, a
 * whole multiple of its step, above zero, within the safe range. Separators
 * and spaces are ignored. Returns null when it is not such an amount.
 */
export function parseUnitAmount(text: string, step = LDC_STEP) {
  const clean = text.replace(/[\s,，]/g, "");
  const decimals = stepDecimals(step);
  const pattern =
    decimals === 0
      ? /^(0|[1-9]\d{0,13})$/
      : new RegExp(`^(0|[1-9]\\d{0,13})(\\.\\d{1,${decimals}})?$`);
  if (!pattern.test(clean)) return null;
  const [whole, fraction = ""] = clean.split(".");
  const cents = BigInt(whole ?? "0") * 100n + BigInt(fraction.padEnd(2, "0"));
  if (cents <= 0n || cents > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  const minor = Number(cents);
  return minor % step === 0 ? minor : null;
}

/**
 * The 1-2-5 series the 最小单位 stepper walks (…0.5, 1, 2, 5, 10…), in 分,
 * from 0.01 to 1 亿.
 */
export const STEP_SERIES: readonly number[] = (() => {
  const series: number[] = [];
  for (let power = 1; power <= MAX_STEP; power *= 10)
    for (const factor of [1, 2, 5]) {
      const value = power * factor;
      if (value <= MAX_STEP) series.push(value);
    }
  return series;
})();

/** The stepper's next value up or down from any step, typed or not. */
export function nextStep(step: number, direction: 1 | -1) {
  if (direction > 0) return STEP_SERIES.find((value) => value > step) ?? null;
  for (let index = STEP_SERIES.length - 1; index >= 0; index -= 1) {
    const value = STEP_SERIES[index];
    if (value !== undefined && value < step) return value;
  }
  return null;
}
