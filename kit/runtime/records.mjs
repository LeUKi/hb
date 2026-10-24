// The sender's full records (JudgeRecords in judge.d.ts) back into what
// each judgment was given: the claims so far, the pool left and the state
// all follow from the judgments before it, as they did on the site.
import { shareRange } from "./money.mjs";

/** Each judgment's submission, in order. */
export function submissionsOf(records) {
  const { hongbao } = records;
  const claims = [];
  let paid = 0;
  let state = null;
  return records.judgments.map((judgment) => {
    const numbers = {
      title: judgment.title,
      total: hongbao.total,
      count: hongbao.count,
      minEach: hongbao.minEach,
      remaining: hongbao.total - paid,
      remainingCount: hongbao.count - claims.length,
      openedAt: hongbao.openedAt,
      endsAt: hongbao.endsAt,
    };
    const submission = {
      input: judgment.input,
      now: judgment.at,
      user: { ...judgment.user },
      hongbao: numbers,
      share: shareRange(numbers),
      claims: claims.map((claim) => ({ ...claim, user: { ...claim.user } })),
      state,
    };
    if ("state" in judgment.verdict) state = judgment.verdict.state ?? null;
    if (judgment.claimedAt !== undefined && judgment.paid !== undefined) {
      claims.push({
        user: { id: judgment.user.id, username: judgment.user.username },
        amount: judgment.paid,
        input: judgment.input,
        at: judgment.claimedAt,
      });
      paid += judgment.paid;
    }
    return submission;
  });
}
