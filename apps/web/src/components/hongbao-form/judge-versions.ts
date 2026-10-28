import type { JudgeVersions } from "@hb/contracts";

// 版本 and 换回 (docs/programmable-hongbao-design.md §5, 07 §5): each new
// code deployed into the form's 判定器 is its 第 n 版, numbered by the
// server in the order deployed (docs/judge-square-design.md §1); a code
// pasted back is known by its fingerprint and keeps its number. The newest
// passing version's code comes with them, so it can be put back without a
// deploy.

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
