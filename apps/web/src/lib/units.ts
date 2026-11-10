// A 红包's amounts by its unit (docs/third-party-points-design.md §2): LDC
// (🐟额红包 too, as before) or its 三方积分's, with that 最小单位's decimals;
// long ones shortened to 万/亿/万亿, the full amount kept for the hint and
// screen readers.

import {
  type ActivityFunding,
  type ActivityPoints,
  type AmountUnit,
  amountToMinor,
  formatDisplayAmount,
  formatFullAmount,
  LDC_UNIT,
} from "@hb/contracts";
import { atom } from "jotai";

/** The unit a 红包 pays in. */
export function unitOf(activity: {
  funding?: ActivityFunding | null;
  points?: ActivityPoints | null;
}): AmountUnit {
  return activity.funding === "points" && activity.points
    ? { unit: activity.points.unit, step: activity.points.step }
    : LDC_UNIT;
}

/** An API amount ("12.34") or 分 as a number, read to 分; null if neither. */
export function minorOf(value: string | number) {
  if (typeof value === "number")
    return Number.isSafeInteger(value) ? value : null;
  const text = value.trim();
  const negative = text.startsWith("-");
  try {
    const minor = amountToMinor(negative ? text.slice(1) : text);
    return negative ? -minor : minor;
  } catch {
    return text === "0" || text === "0.00" ? 0 : null;
  }
}

export type ShownAmount = {
  /** As shown: "1,234.5", "1.2亿". */
  text: string;
  /** In full: "123,456,789". */
  full: string;
  /** Whether text is shortened (the full one goes in a hint). */
  short: boolean;
};

/** An amount as shown in the unit: grouped, shortened when long. */
export function shownAmount(
  value: string | number,
  unit: AmountUnit = LDC_UNIT,
): ShownAmount {
  const minor = minorOf(value);
  if (minor === null) {
    const text = String(value);
    return { text, full: text, short: false };
  }
  return formatDisplayAmount(minor, unit.step);
}

/** "12.5 星星", "1.2亿 LDC". */
export function amountText(
  value: string | number,
  unit: AmountUnit = LDC_UNIT,
) {
  return `${shownAmount(value, unit).text} ${unit.unit}`;
}

/** "123,456,789 星星": in full, for hints and screen readers. */
export function fullAmountText(
  value: string | number,
  unit: AmountUnit = LDC_UNIT,
) {
  const minor = minorOf(value);
  return `${minor === null ? String(value) : formatFullAmount(minor, unit.step)} ${unit.unit}`;
}

/**
 * The unit of the 红包 open now: for what is drawn outside its page's tree
 * (my judgments in their dialog), set by the 红包's view.
 */
export const activeUnitAtom = atom<AmountUnit>(LDC_UNIT);
