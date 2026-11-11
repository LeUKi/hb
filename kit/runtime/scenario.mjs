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

/** The issuer's host a test's 三方积分 has when it names none. */
export const POINTS_TEST_HOST = "points.example.com";

/**
 * hongbao.unit, step and points as the site gives every judge (三方积分,
 * hb's docs/third-party-points-design.md §10): LDC's, unless a test or
 * simulate.json's hongbao.points makes it a 三方积分红包, where every
 * amount the code sees counts its 最小单位.
 */
export function unitFieldsOf(points) {
  if (!points) return { unit: "LDC", step: "0.01", points: null };
  return {
    unit: points.unit,
    step: points.step,
    points: {
      name: points.name,
      unit: points.unit,
      host: points.host ?? POINTS_TEST_HOST,
    },
  };
}

const STEP = /^(?:0|[1-9]\d{0,8})(?:\.\d{1,2})?$/;

// A 单位's width, as the site counts it: a 汉字, full-width character or
// emoji 2, a letter or digit 1, joiners and marks 0.
const WIDE =
  /[\p{Extended_Pictographic}\u1100-\u115F\u2E80-\u303E\u3041-\u33FF\u3400-\u4DBF\u4E00-\u9FFF\uA000-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6\u{20000}-\u{3FFFD}]/u;
const ZERO_WIDTH = /[\p{M}\p{Cf}]/u;
const unitWidth = (value) =>
  [...value].reduce(
    (width, char) =>
      ZERO_WIDTH.test(char) ? width : width + (WIDE.test(char) ? 2 : 1),
    0,
  );

/**
 * A test's or simulate.json's hongbao.points, `{ name, unit, step, host? }`:
 * why it is not one, or null.
 */
export function pointsProblem(points) {
  if (points === undefined) return null;
  if (points === null || typeof points !== "object" || Array.isArray(points))
    return 'hongbao.points 要写成 { "name": "星星", "unit": "星星", "step": "1" }';
  const extra = Object.keys(points).filter(
    (key) => !["name", "unit", "step", "host"].includes(key),
  );
  if (extra.length > 0)
    return `hongbao.points 里没有 ${extra.join("、")} 这一项`;
  const text = (value, max) =>
    typeof value === "string" &&
    value.trim() !== "" &&
    [...value].length <= max;
  if (!text(points.name, 8)) return "hongbao.points.name 要是 1–8 个字";
  if (!text(points.unit, 16) || unitWidth(points.unit.trim()) > 8)
    return "hongbao.points.unit 最多 4 个汉字或 8 个字母";
  if (
    typeof points.step !== "string" ||
    !STEP.test(points.step) ||
    Number(points.step) < 0.01 ||
    Number(points.step) > 100_000_000
  )
    return 'hongbao.points.step 是最小单位，写成字符串，0.01 的整数倍，0.01 到 1 亿（"0.01"、"1"、"100"）';
  if (
    points.host !== undefined &&
    (typeof points.host !== "string" ||
      !/^[a-z0-9.-]+\.[a-z]{2,}$/.test(points.host))
  )
    return "hongbao.points.host 要是发行方的域名，比如 points.example.com";
  return null;
}

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
    ...unitFieldsOf(hongbao.points),
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
      ...unitFieldsOf(hongbao.points),
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
