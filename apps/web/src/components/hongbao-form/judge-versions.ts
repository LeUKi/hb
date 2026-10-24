import {
  JUDGE_LIMITS,
  type JudgeCheck,
  type JudgeVersions,
} from "@hb/contracts";

// 版本 and 换回 (docs/programmable-hongbao-design.md §5, 07 §5): each new
// code this draft deploys is 第 n 版, numbered here in the order deployed;
// a code pasted back is known by its fingerprint and keeps its number. The
// latest passing version's code is kept while the code is another, so it
// can be put back without a deploy. Saved with the draft, encrypted.

export type JudgeVersion = JudgeVersions["versions"][number];

export const noVersions = (): JudgeVersions => ({ next: 1, versions: [] });

/** The version this code is, by its fingerprint. */
export function versionOf(
  versions: JudgeVersions,
  fingerprint: string | null | undefined,
) {
  return fingerprint
    ? versions.versions.find((version) => version.fingerprint === fingerprint)
    : undefined;
}

/**
 * After a run: a new fingerprint becomes 第 next 版, a known one keeps its
 * number and takes this run's outcome. The latest ten are kept, and always
 * the one 换回 names, which the server checks against its code.
 */
export function withRun(
  versions: JudgeVersions,
  check: JudgeCheck,
): JudgeVersions {
  const known = versionOf(versions, check.fingerprint);
  const list = known
    ? versions.versions.map((version) =>
        version === known
          ? { ...version, testsDigest: check.testsDigest, passed: check.passed }
          : version,
      )
    : [
        ...versions.versions,
        {
          n: versions.next,
          fingerprint: check.fingerprint,
          at: check.checkedAt,
          testsDigest: check.testsDigest,
          passed: check.passed,
        },
      ];
  // 换回 only ever names a version whose tests passed.
  const restore = list.some(
    (version) => version.n === versions.restore?.n && version.passed,
  )
    ? versions.restore
    : undefined;
  let over = list.length - JUDGE_LIMITS.versions;
  const kept = list.filter((version) => {
    if (over <= 0 || version.n === restore?.n) return true;
    over -= 1;
    return false;
  });
  return {
    next: known ? versions.next : versions.next + 1,
    versions: kept,
    ...(restore ? { restore } : {}),
  };
}

/**
 * The code replaced: leaving a version whose tests passed keeps its code
 * to go back to; coming back to the code kept, there is nothing to keep.
 * `passing`: the tests as they are (`testsDigest`) passed on the code left
 * (a run of them here, or the draft's word), whatever it last ran.
 */
export function withCodeChange(
  versions: JudgeVersions,
  left: {
    code: string;
    fingerprint: string;
    passing: boolean;
    testsDigest: string | null;
  },
  next: string,
): JudgeVersions {
  const leaving = versionOf(versions, left.fingerprint);
  // The tests that passed on it just now, if they did.
  const passed = left.passing ? left.testsDigest : null;
  const kept =
    leaving && (leaving.passed || passed !== null) && left.code.trim()
      ? leaving
      : undefined;
  const restore = kept ? { n: kept.n, code: left.code } : versions.restore;
  return {
    next: versions.next,
    // 换回 only ever names a version whose tests passed (the schema's rule):
    // the ones that did, now, are its last run.
    versions:
      kept && passed !== null
        ? versions.versions.map((version) =>
            version === kept
              ? { ...version, testsDigest: passed, passed: true }
              : version,
          )
        : versions.versions,
    ...(restore && restore.code !== next ? { restore } : {}),
  };
}

/**
 * judge.js's lines, as the editor numbers them: CodeMirror breaks lines at
 * \r\n and \r too (and gives back \n).
 */
export const splitLines = (text: string) => text.split(/\r\n|\r|\n/);

export const lineCount = (text: string) => splitLines(text).length;

/**
 * “改了 3 行”: the larger of the lines added and removed, past the lines
 * both share (their longest common run, in order). A line edited is one;
 * line endings alone are none, as the editor turns them all into \n.
 */
export function changedLines(before: string, after: string) {
  const a = splitLines(before);
  const b = splitLines(after);
  if (a.length === b.length && a.every((line, index) => line === b[index]))
    return 0;
  // What both start and end with costs nothing to compare.
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start])
    start += 1;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA -= 1;
    endB -= 1;
  }
  const left = a.slice(start, endA);
  const right = b.slice(start, endB);
  if (left.length === 0 || right.length === 0)
    return Math.max(left.length, right.length);
  // Two pastes far apart: no point finding the few lines they share.
  if (left.length * right.length > 4_000_000)
    return Math.max(left.length, right.length);
  let previous = new Uint32Array(right.length + 1);
  let current = new Uint32Array(right.length + 1);
  for (const line of left) {
    for (let j = 1; j <= right.length; j += 1)
      current[j] =
        line === right[j - 1]
          ? (previous[j - 1] ?? 0) + 1
          : Math.max(previous[j] ?? 0, current[j - 1] ?? 0);
    [previous, current] = [current, previous];
  }
  const common = previous[right.length] ?? 0;
  return Math.max(left.length - common, right.length - common);
}
