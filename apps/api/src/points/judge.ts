// 代码判定 with 三方积分 (docs/third-party-points-design.md §10): a judge
// that declares meta.points counts every amount in 最小单位. This site keeps
// 分 throughout; amounts are divided by the step on the way to the code and
// multiplied back on the way out, exact both ways since every amount of such
// a 红包 is a whole number of steps. LDC and 🐟 are step 1: nothing moves.

type HongbaoRow = {
  funding: string;
  config: string;
};

export type JudgeUnit = {
  /** "LDC", "🐟", or the 三方积分's unit. */
  unit: string;
  /** 最小单位 in 分 (1 for LDC and 🐟). */
  step: number;
  /** The 三方积分 as the code may see it; null for LDC and 🐟. */
  points: { name: string; unit: string; host: string } | null;
};

export function judgeUnitOf(activity: HongbaoRow): JudgeUnit {
  if (activity.funding === "points") {
    const points = (
      JSON.parse(activity.config) as {
        points?: { name: string; unit: string; step: number; host: string };
      }
    ).points;
    if (points)
      return {
        unit: points.unit,
        step: points.step,
        points: { name: points.name, unit: points.unit, host: points.host },
      };
  }
  return {
    unit: activity.funding === "balance" ? "🐟" : "LDC",
    step: 1,
    points: null,
  };
}

/** "0.01", "1", "100": the step as the code reads it. */
export function stepText(step: number) {
  const whole = Math.floor(step / 100);
  const cents = step % 100;
  if (cents === 0) return String(whole);
  return `${whole}.${String(cents).padStart(2, "0")}`.replace(/0$/, "");
}

const units = (minor: number, step: number) => {
  if (minor % step !== 0)
    throw new Error("A 三方积分 amount is not a whole number of steps");
  return minor / step;
};

/** The hongbao a judge gets: its unit added; in steps for 三方积分. */
export function hongbaoForJudge<
  T extends {
    total: number;
    count: number;
    minEach?: number;
    remaining?: number;
    remainingCount?: number;
    unclaimed?: number;
  },
>(hongbao: T, unit: JudgeUnit) {
  const extra = {
    unit: unit.unit,
    step: stepText(unit.step),
    points: unit.points,
  };
  if (unit.step === 1) return { ...hongbao, ...extra };
  const total = units(hongbao.total, unit.step);
  const count = Math.max(1, Math.floor(total / 100));
  return {
    ...hongbao,
    ...extra,
    total,
    count,
    ...(hongbao.minEach === undefined ? {} : { minEach: 1 }),
    ...(hongbao.remaining === undefined
      ? {}
      : { remaining: units(hongbao.remaining, unit.step) }),
    ...(hongbao.remainingCount === undefined
      ? {}
      : {
          remainingCount: Math.max(
            1,
            count - (hongbao.count - hongbao.remainingCount),
          ),
        }),
    ...(hongbao.unclaimed === undefined
      ? {}
      : { unclaimed: units(hongbao.unclaimed, unit.step) }),
  };
}

/** A whole submission for the code (protocol 5): its amounts in steps. */
export function submissionForJudge<
  S extends {
    hongbao: {
      total: number;
      count: number;
      minEach: number;
      remaining: number;
      remainingCount: number;
      unclaimed: number;
    };
    share: { min: number; max: number; last: boolean };
    claims: { amount: number }[];
    player: { pending: number };
  },
>(submission: S, unit: JudgeUnit): S {
  const hongbao = hongbaoForJudge(submission.hongbao, unit);
  if (unit.step === 1) return { ...submission, hongbao };
  return {
    ...submission,
    hongbao,
    share: {
      min: 1,
      max: units(submission.share.max, unit.step),
      last: submission.share.last,
    },
    claims: submission.claims.map((claim) => ({
      ...claim,
      amount: units(claim.amount, unit.step),
    })),
    player: {
      ...submission.player,
      pending: units(submission.player.pending, unit.step),
    },
  };
}

/** The code's answer back in 分: its adds, its own and others', times the step. */
export function readingFromJudge<
  R extends { add: number; others: { add: number }[] },
>(reading: R, unit: JudgeUnit): R {
  if (unit.step === 1) return reading;
  const scaled = (value: number) => {
    const minor = value * unit.step;
    if (!Number.isSafeInteger(minor))
      throw new Error("A judged amount is out of range");
    return minor;
  };
  return {
    ...reading,
    add: scaled(reading.add),
    others: reading.others.map((other) => ({
      ...other,
      add: scaled(other.add),
    })),
  };
}
