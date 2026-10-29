// A 红包 judged one submission after another, carried forward as the site
// does (协议第 5 节, 多步场景): each judgment leaves the state it wrote (or
// keeps the one it had), one more judgment for that person, and, when it
// paid, a claim with what was paid at its time. From protocol 4 it leaves
// its view too, and one that ends the 红包 is the last. tests.json's steps,
// npm run simulate and npm run replay all go through here.
import { shareRange } from "./money.mjs";
import { submissionSeed, userSeed } from "./seeds.mjs";
import { readVerdict, VIEW_PROTOCOL } from "./verdict.mjs";

const copyClaim = (claim) => ({ ...claim, user: { ...claim.user } });

/**
 * A 红包 before its first submission here: `hongbao` its fixed numbers
 * (title, total, count, minEach, openedAt, endsAt), the claims already in,
 * the code's state and its view (protocol 4, null for none). `hongbaoId`
 * and `secret` make each submission's seeds; a replay before the seed is
 * out has no secret. `params`, from the third protocol, is
 * submission.params (none before it: an earlier 红包's submissions stay
 * as they were). `protocol` is how its answers are read.
 */
export function startScenario({
  hongbao,
  claims = [],
  state = null,
  view = null,
  hongbaoId,
  secret = null,
  params,
  protocol = VIEW_PROTOCOL,
}) {
  return {
    ...(params !== undefined ? { params } : {}),
    protocol,
    hongbao: { ...hongbao },
    claims: claims.map(copyClaim),
    paid: claims.reduce((sum, claim) => sum + claim.amount, 0),
    state,
    view,
    /** A judgment ended it (protocol 4, end). */
    ended: false,
    /** User ID → how many times the code judged them here. */
    judged: new Map(),
    hongbaoId,
    secret,
  };
}

/**
 * Why the site would not hand this person's submission to the code
 * (协议第 4.1 节): "ended" once a judgment ended it, "claimed" when they
 * have a share, "sold-out" when no share is left; null when it would.
 */
export function refusalOf(scenario, user) {
  if (scenario.ended) return "ended";
  if (scenario.claims.some((claim) => claim.user.id === user.id))
    return "claimed";
  if (scenario.claims.length >= scenario.hongbao.count) return "sold-out";
  return null;
}

/**
 * What the code is given next. `user.attempts` is counted here unless the
 * caller has it (a test that says so, a record that kept it); `title` is
 * the 红包's title at the time, when it changed.
 */
export function nextSubmission(scenario, { input, now, user, title }) {
  const { hongbao } = scenario;
  const numbers = {
    title: title ?? hongbao.title,
    total: hongbao.total,
    count: hongbao.count,
    minEach: hongbao.minEach,
    remaining: hongbao.total - scenario.paid,
    remainingCount: hongbao.count - scenario.claims.length,
    openedAt: hongbao.openedAt,
    endsAt: hongbao.endsAt,
  };
  return {
    input,
    now,
    user: {
      id: user.id,
      username: user.username,
      level: user.level,
      attempts: user.attempts ?? scenario.judged.get(user.id) ?? 0,
    },
    hongbao: numbers,
    share: shareRange(numbers),
    claims: scenario.claims.map(copyClaim),
    state: scenario.state,
    ...(scenario.params !== undefined
      ? { params: structuredClone(scenario.params) }
      : {}),
  };
}

/**
 * One judgment's mark on the 红包: `state` and `view` as readVerdict gives
 * them (`{ keep: true }` or `{ keep: false, value }`), `end`, and `paid`
 * with `at` when a share was claimed (before it ends, as on the site).
 */
export function advance(scenario, submission, { state, view, end, paid, at }) {
  const { user } = submission;
  scenario.judged.set(user.id, (scenario.judged.get(user.id) ?? 0) + 1);
  if (!state.keep) scenario.state = state.value;
  if (view && !view.keep) scenario.view = view.value;
  if (end) scenario.ended = true;
  if (paid === undefined) return;
  scenario.claims.push({
    user: { id: user.id, username: user.username },
    amount: paid,
    input: submission.input,
    at,
  });
  scenario.paid += paid;
}

/**
 * One submission at `at`, judged by `run` (the sandbox: `{ verdict }` or
 * `{ failure, detail }`, given `fetch`, the answers its requests get when
 * they are written down) and the 红包 moved on. `{ refused }` when the site
 * would not have asked the code; otherwise what was given, how the sandbox
 * answered, the time it took and, for an answer, how readVerdict read it.
 * Only an answer that follows the protocol moves anything on: a failure
 * counts for nothing, as on the site.
 */
export async function judgeNext(scenario, { user, input, at, fetch }, run) {
  const refused = refusalOf(scenario, user);
  if (refused) return { refused };
  const submission = nextSubmission(scenario, { input, now: at, user });
  const { id, attempts } = submission.user;
  const seeds = {
    submission: submissionSeed(
      scenario.hongbaoId,
      scenario.secret,
      id,
      attempts,
    ),
    user: userSeed(scenario.hongbaoId, scenario.secret, id),
  };
  const started = Date.now();
  const answer = await run(submission, seeds, fetch);
  const ms = Date.now() - started;
  if ("failure" in answer) return { submission, seeds, answer, ms };
  const reading = readVerdict(
    answer.verdict,
    submission.share,
    scenario.protocol,
  );
  if (!("error" in reading))
    advance(scenario, submission, {
      state: reading.state,
      view: reading.view,
      end: reading.end,
      ...(reading.ok ? { paid: reading.paid, at } : {}),
    });
  return { submission, seeds, answer, ms, reading };
}
