// A 红包 judged one submission after another, carried forward as the site
// does (协议第 5 节, 多步场景): each judgment leaves the state it wrote (or
// keeps the one it had), one more judgment for that person, and, when it
// paid, a claim with what was paid at its time. From protocol 4 it leaves
// its view too, and one that ends the 红包 is the last. From protocol 5
// (docs/multi-prize-design.md) there are no shares: each person has
// pending, their own state and view, and is settled once — by the code, or
// by the site when the 红包 ends (ledger.mjs). tests.json's steps, npm run
// simulate and npm run replay all go through here.
import { moveMoney, othersProblem } from "./ledger.mjs";
import { defaultCount, shareRange } from "./money.mjs";
import { submissionSeed, userSeed } from "./seeds.mjs";
import { LEDGER_PROTOCOL, readVerdict } from "./verdict.mjs";

const copyClaim = (claim) => ({ ...claim, user: { ...claim.user } });

/**
 * A 红包 before its first submission here: `hongbao` its fixed numbers
 * (title, total, count, minEach, openedAt, endsAt; from protocol 5 no
 * count or minEach), the claims already in, the code's state and its view
 * (protocol 4, null for none). `hongbaoId` and `secret` make each
 * submission's seeds; a replay before the seed is out has no secret.
 * `params`, from the third protocol, is submission.params (none before
 * it: an earlier 红包's submissions stay as they were). `protocol` is how
 * its answers are read. From protocol 5 `players` are people judged here
 * before and not settled: `{ user: { id, username }, pending, state, view,
 * judged, input }`, all but user optional.
 */
export function startScenario({
  hongbao,
  claims = [],
  players = [],
  state = null,
  view = null,
  hongbaoId,
  secret = null,
  params,
  protocol = LEDGER_PROTOCOL,
}) {
  const scenario = {
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
  if (protocol < LEDGER_PROTOCOL) return scenario;
  /** User ID → their part (protocol 5), in the order first judged. */
  scenario.people = new Map();
  /** Everyone's pending, together. */
  scenario.pending = 0;
  /** What ended it (protocol 5): "judge" (end), "empty" or "deadline". */
  scenario.endedBy = null;
  for (const player of players) {
    const pending = player.pending ?? 0;
    scenario.people.set(player.user.id, {
      user: { id: player.user.id, username: player.user.username },
      pending,
      settled: null,
      state: player.state ?? null,
      view: player.view ?? null,
      input: player.input ?? "占位",
    });
    scenario.pending += pending;
    scenario.judged.set(player.user.id, player.judged ?? 1);
  }
  return scenario;
}

const ledgered = (scenario) => scenario.protocol >= LEDGER_PROTOCOL;

/**
 * What is not taken (protocol 5): the pool less what was paid and
 * everyone's pending. The 红包 ends when it comes to 0.
 */
export function unclaimedOf(scenario) {
  return scenario.hongbao.total - scenario.paid - scenario.pending;
}

/**
 * Whether `others` may name this person (protocol 5; ledger.mjs
 * othersProblem): "unknown", "settled" or null.
 */
export function standingOf(scenario, id) {
  if (scenario.claims.some((claim) => claim.user.id === id)) return "settled";
  const person = scenario.people.get(id);
  if (!person) return "unknown";
  return person.settled !== null ? "settled" : null;
}

/**
 * Why the site would not hand this person's submission to the code
 * (协议第 4.1 节): "ended" once a judgment ended it, "claimed" when they
 * have a share, "sold-out" when no share is left; null when it would.
 * From protocol 5, "settled" once they are, and no shares to run out.
 */
export function refusalOf(scenario, user) {
  if (scenario.ended) return "ended";
  if (ledgered(scenario))
    return standingOf(scenario, user.id) === "settled" ? "settled" : null;
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
  if (ledgered(scenario))
    return nextLedgered(scenario, { input, now, user, title });
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
 * Protocol 5's submission (docs/multi-prize-design.md §3.1, §3.5): the old
 * numbers as n shares would have them, n about 1 LDC each
 * (hongbao.count), with `unclaimed`; `player`, this person's pending and
 * own state and view.
 */
function nextLedgered(scenario, { input, now, user, title }) {
  const { hongbao } = scenario;
  const count = defaultCount(hongbao.total);
  const unclaimed = unclaimedOf(scenario);
  const own = scenario.people.get(user.id);
  return {
    input,
    now,
    user: {
      id: user.id,
      username: user.username,
      level: user.level,
      attempts: user.attempts ?? scenario.judged.get(user.id) ?? 0,
    },
    hongbao: {
      title: title ?? hongbao.title,
      total: hongbao.total,
      count,
      minEach: 1,
      remaining: hongbao.total - scenario.paid,
      remainingCount: Math.max(1, count - scenario.claims.length),
      unclaimed,
      openedAt: hongbao.openedAt,
      endsAt: hongbao.endsAt,
    },
    share: { min: 1, max: unclaimed, last: false },
    claims: scenario.claims.map(copyClaim),
    state: scenario.state,
    ...(scenario.params !== undefined
      ? { params: structuredClone(scenario.params) }
      : {}),
    player: {
      pending: own?.pending ?? 0,
      state: own?.state ?? null,
      view: own?.view ?? null,
    },
  };
}

/** Settles one person (protocol 5): their pending paid, a claim when not 0. */
function settleOne(scenario, person, at) {
  const amount = person.pending;
  person.settled = amount;
  person.pending = 0;
  scenario.pending -= amount;
  if (amount > 0) {
    scenario.claims.push({
      user: { ...person.user },
      amount,
      input: person.input,
      at,
    });
    scenario.paid += amount;
  }
  return { id: person.user.id, username: person.user.username, amount };
}

/**
 * Ends it (protocol 5): everyone not settled is, in the order first
 * judged, as the site does when the 红包 ends (`by` "judge", "empty" or
 * "deadline"). Those settled, `{ id, username, amount }`.
 */
export function endScenario(scenario, by, at) {
  scenario.ended = true;
  scenario.endedBy = by;
  const settled = [];
  for (const person of scenario.people.values())
    if (person.settled === null) settled.push(settleOne(scenario, person, at));
  return settled;
}

/**
 * Protocol 5: one judgment's mark (§2, §3): the one judged counted, their
 * input kept (a claim says it); the shared state and view; each add moved
 * (ledger.mjs moveMoney), the one judged first, then `others` in order;
 * each one's own state and view; then whoever is to settle, and everyone
 * once the judgment ended it or nothing is left unclaimed. `others` were
 * checked (othersProblem). What moved, for saying: `moves` `{ id,
 * username, before, after, add, settle, message }` (the one judged first;
 * `message` is what others were told), `settled` `{ id, username, amount }`
 * and `ended`: "judge", "empty" or null.
 */
export function advanceLedger(scenario, submission, reading, at) {
  const { user } = submission;
  scenario.judged.set(user.id, (scenario.judged.get(user.id) ?? 0) + 1);
  let self = scenario.people.get(user.id);
  if (!self) {
    self = {
      user: { id: user.id, username: user.username },
      pending: 0,
      settled: null,
      state: null,
      view: null,
      input: submission.input,
    };
    scenario.people.set(user.id, self);
  }
  self.user.username = user.username;
  self.input = submission.input;
  if (!reading.state.keep) scenario.state = reading.state.value;
  if (!reading.view.keep) scenario.view = reading.view.value;
  const writes = [
    {
      person: self,
      ...reading.player,
      add: reading.add,
      settle: reading.settle,
    },
    ...reading.others.map((other) => ({
      ...other,
      person: scenario.people.get(other.id),
    })),
  ];
  const moved = moveMoney(
    unclaimedOf(scenario),
    writes.map(({ person, add }) => ({
      id: person.user.id,
      pending: person.pending,
      add,
    })),
  );
  const moves = writes.map((write, index) => {
    const { person } = write;
    const { before, after } = moved.moves[index];
    person.pending = after;
    scenario.pending += after - before;
    if (!write.state.keep) person.state = write.state.value;
    if (!write.view.keep) person.view = write.view.value;
    return {
      id: person.user.id,
      username: person.user.username,
      before,
      after,
      add: write.add,
      settle: write.settle,
      ...(index > 0 && write.message !== undefined
        ? { message: write.message }
        : {}),
    };
  });
  const settled = writes
    .filter((write) => write.settle)
    .map(({ person }) => settleOne(scenario, person, at));
  const ended = reading.end ? "judge" : moved.unclaimed === 0 ? "empty" : null;
  if (ended) settled.push(...endScenario(scenario, ended, at));
  return { moves, settled, ended };
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
  let reading = readVerdict(
    answer.verdict,
    submission.share,
    scenario.protocol,
  );
  if ("error" in reading) return { submission, seeds, answer, ms, reading };
  if (!ledgered(scenario)) {
    advance(scenario, submission, {
      state: reading.state,
      view: reading.view,
      end: reading.end,
      ...(reading.ok ? { paid: reading.paid, at } : {}),
    });
    return { submission, seeds, answer, ms, reading };
  }
  // Protocol 5: naming someone who may not be named is the code's error.
  const problem = othersProblem(reading.others, id, (other) =>
    standingOf(scenario, other),
  );
  if (problem) {
    reading = { error: { kind: "invalid", detail: problem } };
    return { submission, seeds, answer, ms, reading };
  }
  const ledger = advanceLedger(scenario, submission, reading, at);
  return { submission, seeds, answer, ms, reading, ledger };
}
