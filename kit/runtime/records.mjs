// The sender's full records (JudgeRecords in judge.d.ts) back into what
// each judgment was given: the claims so far, the pool left and the state
// all follow from the judgments before it, stepped on as the site did
// (scenario.mjs).
import { advance, nextSubmission, startScenario } from "./scenario.mjs";

/**
 * What a judgment's requests got (协议第 9 节), as a test writes its answers
 * (`fetch`): so a replay answers them as the site's gateway did.
 */
export function answersOf(judgment) {
  return (judgment.fetches ?? []).map((asked) =>
    asked.error
      ? { url: asked.url, method: asked.method, error: asked.error }
      : {
          url: asked.url,
          method: asked.method,
          status: asked.status,
          headers: asked.contentType
            ? { "content-type": asked.contentType }
            : {},
          text: asked.response ?? "",
        },
  );
}

/** Each judgment's submission, in order. */
export function submissionsOf(records) {
  const { hongbao } = records;
  const scenario = startScenario({
    hongbao: {
      total: hongbao.total,
      count: hongbao.count,
      minEach: hongbao.minEach,
      openedAt: hongbao.openedAt,
      endsAt: hongbao.endsAt,
    },
    hongbaoId: hongbao.id,
    secret: hongbao.seed,
  });
  return records.judgments.map((judgment) => {
    const submission = nextSubmission(scenario, {
      input: judgment.input,
      now: judgment.at,
      user: judgment.user,
      title: judgment.title,
    });
    // A share judged but never claimed (the 红包 ended first) is no claim.
    const claimed =
      judgment.claimedAt !== undefined && judgment.paid !== undefined;
    advance(scenario, submission, {
      state:
        "state" in judgment.verdict
          ? { keep: false, value: judgment.verdict.state ?? null }
          : { keep: true },
      ...(claimed ? { paid: judgment.paid, at: judgment.claimedAt } : {}),
    });
    return submission;
  });
}
