// 判定器 (docs/judge-square-design.md §1): code made to be used again. A
// deploy goes into one of its author's 判定器 (a new one takes a name), as
// the next version or, for code it has, a rerun of that version; every
// version keeps its code and the tests of its last run, encrypted. A draft
// names the 判定器 its code is written in or picked from. 红包 sent before
// 判定器 existed get one each, the first time their sender reads them or by
// the maintenance task, whichever comes first (§14.3).
import type {
  JudgeCheck,
  JudgeCheckInput,
  JudgeDeclarations,
  JudgeParamsCheck,
  JudgeParamsCheckInput,
  JudgeTry,
  JudgeTryInput,
  JudgeVersions,
  MyJudge,
  MyJudgeDetail,
  MyJudgeVersion,
  UpdateJudgeInput,
} from "@hb/contracts";
import { JUDGE_OLDEST_PROTOCOL } from "@hb/contracts";
import {
  defaultCount,
  moveMoney,
  nextSubmission,
  othersProblem,
  paramValues,
  readCheckAnswer,
  readVerdict,
  startScenario,
  submissionSeed,
  userSeed,
} from "../../../../kit/runtime/index.mjs";
import { ActivityError } from "../activities/errors";
import type { ApiBindings } from "../env";
import { decryptString, encryptString } from "../security/crypto";
import { checkJudge, RUNS_PER_DAY, runsToday } from "./check";
import { checkParamsInJudge, JUDGE_PROTOCOL, runJudge } from "./sandbox";
import { publicVersionOf, usableByOthers } from "./square";
import { judgeData, textDigest } from "./storage";
import { usageStatement } from "./usage";

/** What each encrypted part of a version is bound to. */
export const versionData = (
  judgeId: string,
  n: number,
  part: "code" | "tests",
) => `judge-version:${judgeId}:${n}:${part}`;

/** A draft's version list shows the newest ten (JudgeVersions). */
const LISTED = 10;
/** 红包 a maintenance run moves over (§14.3). */
const MIGRATED_A_RUN = 25;

type JudgeRecord = {
  id: string;
  author_id: string;
  name: string;
  description: string;
  code_public: "ended" | "always";
  based_on_judge_id: string | null;
  listed_at: number | null;
  featurable: number;
  taken_down_at: number | null;
  taken_down_reason: string | null;
  created_at: number;
  updated_at: number;
};

type VersionRecord = {
  judge_id: string;
  n: number;
  fingerprint: string;
  code_ciphertext: string;
  protocol: number;
  tests_ciphertext: string;
  tests_digest: string;
  passed: number;
  declarations: string | null;
  network: string | null;
  deployed_at: number;
  checked_at: number;
};

const iso = (at: number) => new Date(at).toISOString();
const listOf = (json: string | null) =>
  json === null ? null : (JSON.parse(json) as string[]);
const declarationsOf = (json: string | null) =>
  json === null ? null : (JSON.parse(json) as JudgeDeclarations);

function notFound(): never {
  throw new ActivityError(404, "JUDGE_NOT_FOUND", "未找到判定器");
}

/** One of this person's 判定器, or 未找到. */
export async function ownJudge(
  env: ApiBindings,
  judgeId: string,
  userId: string,
) {
  const row = await env.DB.prepare(
    "SELECT * FROM judges WHERE id = ? AND author_id = ?",
  )
    .bind(judgeId, userId)
    .first<JudgeRecord>();
  return row ?? notFound();
}

/**
 * The 判定器 a copy is based on (§8 复制一份来改): one in the 广场, or the
 * copier's own; 未找到 otherwise.
 */
async function copiedFrom(env: ApiBindings, judgeId: string, userId: string) {
  const row = await env.DB.prepare(
    `SELECT id FROM judges WHERE id = ? AND (author_id = ?
      OR (listed_at IS NOT NULL AND taken_down_at IS NULL))`,
  )
    .bind(judgeId, userId)
    .first<{ id: string }>();
  return row?.id ?? notFound();
}

/** The version this code is in this 判定器, if it was deployed there. */
export async function versionNumberOf(
  env: ApiBindings,
  judgeId: string,
  fingerprint: string,
) {
  return env.DB.prepare(
    "SELECT n FROM judge_versions WHERE judge_id = ? AND fingerprint = ?",
  )
    .bind(judgeId, fingerprint)
    .first<number>("n");
}

/**
 * A 判定器's versions as a draft shows them (版本, 换回): the newest ten,
 * and the code of the newest that passed, to put back.
 */
export async function draftVersionsOf(
  env: ApiBindings,
  judgeId: string,
): Promise<JudgeVersions> {
  const rows = (
    await env.DB.prepare(
      "SELECT * FROM judge_versions WHERE judge_id = ? ORDER BY n DESC LIMIT ?",
    )
      .bind(judgeId, LISTED)
      .all<VersionRecord>()
  ).results;
  const restore = rows.find((row) => row.passed === 1);
  return {
    next: (rows[0]?.n ?? 0) + 1,
    versions: rows
      .map((row) => {
        const network = listOf(row.network);
        return {
          n: row.n,
          fingerprint: row.fingerprint,
          at: iso(row.deployed_at),
          testsDigest: row.tests_digest,
          passed: row.passed === 1,
          protocol: row.protocol,
          ...(network ? { network } : {}),
        };
      })
      .reverse(),
    ...(restore
      ? {
          restore: {
            n: restore.n,
            code: await decryptString(
              restore.code_ciphertext,
              env,
              versionData(judgeId, restore.n, "code"),
            ),
          },
        }
      : {}),
  };
}

/**
 * 部署 into a 判定器 (§1): run as ever (check.ts), then kept as the next
 * version of the 判定器 named — or, for code it already has, as that
 * version's last run. A new 判定器 is made by this first deploy. Without a
 * 判定器 named, a run is kept nowhere (a page from before 判定器).
 */
export async function deployJudge(
  env: ApiBindings,
  userId: string,
  input: JudgeCheckInput,
): Promise<JudgeCheck> {
  const target = input.judge;
  const existing =
    target && "id" in target ? await ownJudge(env, target.id, userId) : null;
  // 复制一份来改 (§8): from one this person may see — its source kept.
  // Asked before the run, which counts.
  const basedOn =
    target && !existing && "basedOn" in target && target.basedOn
      ? await copiedFrom(env, target.basedOn, userId)
      : null;
  const check = await checkJudge(env, userId, {
    code: input.code,
    tests: input.tests,
  });
  if (!target) return check;
  const now = Date.now();
  const judgeId = existing?.id ?? crypto.randomUUID();
  const name = existing?.name ?? ("name" in target ? target.name : "");
  const description =
    existing?.description ??
    ("name" in target ? (target.description ?? "") : "");
  // Made with its settings (§16.1): in the 广场 is public for good, as
  // joining it later is. Made outside it and joined in the same batch
  // (the database's rule: judges_insert_guard).
  const made = "name" in target ? target : null;
  const listed = made?.listing?.listed === true;
  const known = existing
    ? await versionNumberOf(env, judgeId, check.fingerprint)
    : null;
  const n =
    known ??
    ((existing
      ? await env.DB.prepare(
          "SELECT MAX(n) AS n FROM judge_versions WHERE judge_id = ?",
        )
          .bind(judgeId)
          .first<number | null>("n")
      : 0) ?? 0) + 1;
  const network =
    check.network && !check.networkProblems
      ? JSON.stringify(check.network)
      : null;
  const declarations =
    check.protocol >= 3 ? JSON.stringify(check.declarations) : null;
  const tests = await encryptString(
    input.tests,
    env,
    versionData(judgeId, n, "tests"),
  );
  await env.DB.batch([
    existing
      ? env.DB.prepare("UPDATE judges SET updated_at = ? WHERE id = ?").bind(
          now,
          judgeId,
        )
      : env.DB.prepare(
          `INSERT INTO judges (id, author_id, name, description, based_on_judge_id, code_public,
            featurable, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).bind(
          judgeId,
          userId,
          name,
          description,
          basedOn,
          listed || made?.codePublic === "always" ? "always" : "ended",
          Number(made?.listing?.featurable ?? true),
          now,
          now,
        ),
    ...(!existing && listed
      ? [
          env.DB.prepare("UPDATE judges SET listed_at = ? WHERE id = ?").bind(
            now,
            judgeId,
          ),
        ]
      : []),
    known !== null
      ? env.DB.prepare(`UPDATE judge_versions SET protocol = ?, tests_ciphertext = ?, tests_digest = ?,
          passed = ?, declarations = ?, network = ?, checked_at = ? WHERE judge_id = ? AND n = ?`).bind(
          check.protocol,
          tests,
          check.testsDigest,
          Number(check.passed),
          declarations,
          network,
          now,
          judgeId,
          n,
        )
      : env.DB.prepare(`INSERT INTO judge_versions (judge_id, n, fingerprint, code_ciphertext, protocol,
          tests_ciphertext, tests_digest, passed, declarations, network, deployed_at, checked_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(
          judgeId,
          n,
          check.fingerprint,
          await encryptString(input.code, env, versionData(judgeId, n, "code")),
          check.protocol,
          tests,
          check.testsDigest,
          Number(check.passed),
          declarations,
          network,
          now,
          now,
        ),
  ]);
  return {
    ...check,
    judge: {
      id: judgeId,
      name,
      description,
      version: n,
      versions: await draftVersionsOf(env, judgeId),
    },
  };
}

/** 红包 opened with each of these 判定器 (by version when asked). */
const OPENED = `(SELECT COUNT(*) FROM activity_code c JOIN activities a ON a.id = c.activity_id
  WHERE c.judge_id = j.id AND a.opened_at IS NOT NULL)`;

type ListedJudge = JudgeRecord & {
  opened: number;
  latest_n: number | null;
  latest_at: number | null;
  latest_passed: number | null;
  usable_n: number | null;
  stat_hongbao: number | null;
  stat_judged: number | null;
  stat_claimed: number | null;
  featured_n: number | null;
};

const SUMMARY = `SELECT j.*, ${OPENED} AS opened,
    (SELECT n FROM judge_versions WHERE judge_id = j.id ORDER BY n DESC LIMIT 1) AS latest_n,
    (SELECT deployed_at FROM judge_versions WHERE judge_id = j.id ORDER BY n DESC LIMIT 1) AS latest_at,
    (SELECT passed FROM judge_versions WHERE judge_id = j.id ORDER BY n DESC LIMIT 1) AS latest_passed,
    (SELECT n FROM judge_versions WHERE judge_id = j.id AND passed = 1 ORDER BY n DESC LIMIT 1) AS usable_n,
    s.hongbao AS stat_hongbao, s.judged AS stat_judged, s.claimed AS stat_claimed, f.n AS featured_n
  FROM judges j LEFT JOIN judge_stats s ON s.judge_id = j.id LEFT JOIN judge_features f ON f.judge_id = j.id`;

async function summaryOf(env: ApiBindings, row: ListedJudge): Promise<MyJudge> {
  const usable =
    row.usable_n === null
      ? null
      : await env.DB.prepare(
          "SELECT protocol, declarations, network FROM judge_versions WHERE judge_id = ? AND n = ?",
        )
          .bind(row.id, row.usable_n)
          .first<
            Pick<VersionRecord, "protocol" | "declarations" | "network">
          >();
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    codePublic: row.code_public,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    latest:
      row.latest_n === null || row.latest_at === null
        ? null
        : {
            n: row.latest_n,
            deployedAt: iso(row.latest_at),
            passed: row.latest_passed === 1,
          },
    usable:
      row.usable_n === null || !usable
        ? null
        : {
            n: row.usable_n,
            declarations: declarationsOf(usable.declarations),
            network: listOf(usable.network),
            ...(usable.protocol < JUDGE_OLDEST_PROTOCOL
              ? { old: true as const }
              : {}),
          },
    opened: row.opened,
    listed: row.listed_at !== null,
    featurable: row.featurable === 1,
    takenDown:
      row.taken_down_at !== null && row.taken_down_reason !== null
        ? { at: iso(row.taken_down_at), reason: row.taken_down_reason }
        : null,
    featured: row.featured_n,
    stats: {
      hongbao: row.stat_hongbao ?? 0,
      judged: row.stat_judged ?? 0,
      claimed: row.stat_claimed ?? 0,
    },
  };
}

/** 我的判定器 (§1 认得出来): the newest first, with their sender's 红包 moved over. */
export async function listMyJudges(
  env: ApiBindings,
  userId: string,
): Promise<MyJudge[]> {
  await migrateJudgesOf(env, { userId });
  const rows = (
    await env.DB.prepare(
      `${SUMMARY} WHERE j.author_id = ? ORDER BY j.updated_at DESC, j.id`,
    )
      .bind(userId)
      .all<ListedJudge>()
  ).results;
  return Promise.all(rows.map((row) => summaryOf(env, row)));
}

/** One's own 判定器 with every version (判定器页, §8). */
export async function getMyJudge(
  env: ApiBindings,
  userId: string,
  judgeId: string,
): Promise<MyJudgeDetail> {
  const row = await env.DB.prepare(
    `${SUMMARY} WHERE j.id = ? AND j.author_id = ?`,
  )
    .bind(judgeId, userId)
    .first<ListedJudge>();
  if (!row) notFound();
  const versions = (
    await env.DB.prepare(
      `SELECT v.*, (SELECT COUNT(*) FROM activity_code c JOIN activities a ON a.id = c.activity_id
          WHERE c.judge_id = v.judge_id AND c.judge_version = v.n AND a.opened_at IS NOT NULL) AS opened
        FROM judge_versions v WHERE v.judge_id = ? ORDER BY v.n DESC`,
    )
      .bind(judgeId)
      .all<VersionRecord & { opened: number }>()
  ).results;
  return {
    ...(await summaryOf(env, row)),
    publicN: await publicVersionOf(env, judgeId),
    versions: versions.map(
      (version): MyJudgeVersion => ({
        n: version.n,
        fingerprint: version.fingerprint,
        deployedAt: iso(version.deployed_at),
        checkedAt: iso(version.checked_at),
        protocol: version.protocol,
        testsDigest: version.tests_digest,
        passed: version.passed === 1,
        network: listOf(version.network),
        declarations: declarationsOf(version.declarations),
        opened: version.opened,
      }),
    ),
  };
}

/**
 * One version's code and the tests of its last run (查看代码; picking it for
 * a draft, which then holds them as its own).
 */
export async function myJudgeVersion(
  env: ApiBindings,
  userId: string,
  judgeId: string,
  n: number,
) {
  await ownJudge(env, judgeId, userId);
  const row = await env.DB.prepare(
    "SELECT * FROM judge_versions WHERE judge_id = ? AND n = ?",
  )
    .bind(judgeId, n)
    .first<VersionRecord>();
  if (!row) notFound();
  const [code, tests, versions] = await Promise.all([
    decryptString(row.code_ciphertext, env, versionData(judgeId, n, "code")),
    decryptString(row.tests_ciphertext, env, versionData(judgeId, n, "tests")),
    draftVersionsOf(env, judgeId),
  ]);
  return {
    code,
    tests,
    versions,
    declarations: declarationsOf(row.declarations),
  };
}

/**
 * A version of a 判定器 to run on a sender's behalf (check, 试一试) — their
 * own, or another's they may use:
 * its code, what it declares, and the params given, as the code would get
 * them — or the first thing wrong with them.
 */
async function versionToRun(
  env: ApiBindings,
  userId: string,
  judgeId: string,
  n: number,
  params: Record<string, unknown>,
) {
  // Another's (judge-square §15.3): a version others may use, or the one a
  // draft of theirs has.
  const judge = await env.DB.prepare(
    "SELECT author_id, listed_at, taken_down_at FROM judges WHERE id = ?",
  )
    .bind(judgeId)
    .first<{
      author_id: string;
      listed_at: number | null;
      taken_down_at: number | null;
    }>();
  if (!judge) notFound();
  if (
    judge.author_id !== userId &&
    !(await env.DB.prepare(
      `SELECT 1 FROM activity_code c JOIN activities a ON a.id = c.activity_id
        WHERE c.judge_id = ? AND c.judge_version = ? AND a.author_id = ? AND a.deleted_at IS NULL LIMIT 1`,
    )
      .bind(judgeId, n, userId)
      .first()) &&
    !(
      judge.listed_at !== null &&
      judge.taken_down_at === null &&
      (await usableByOthers(env, judgeId, n))
    )
  )
    notFound();
  const row = await env.DB.prepare(
    "SELECT * FROM judge_versions WHERE judge_id = ? AND n = ?",
  )
    .bind(judgeId, n)
    .first<VersionRecord>();
  if (!row) notFound();
  const declarations = declarationsOf(row.declarations);
  const read = paramValues(declarations?.params ?? [], params);
  return {
    row,
    declarations,
    read,
    code: () =>
      decryptString(row.code_ciphertext, env, versionData(judgeId, n, "code")),
  };
}

/**
 * check() and 试一试 count toward the runs a day nobody is shown (§3, §6):
 * held at RUNS_PER_DAY, and written down with the 判定器's 用量 (§7).
 */
async function holdTries(env: ApiBindings, userId: string) {
  if ((await runsToday(env, userId)).runs >= RUNS_PER_DAY)
    throw new ActivityError(
      429,
      "JUDGE_RUN_LIMIT",
      "今天试得太多了，明天再来。",
    );
}

function tryStatements(
  env: ApiBindings,
  userId: string,
  kind: "check" | "try",
  fingerprint: string,
  now: number,
) {
  return [
    env.DB.prepare(
      "INSERT INTO judge_tries (id, user_id, kind, created_at) VALUES (?, ?, ?, ?)",
    ).bind(crypto.randomUUID(), userId, kind, now),
    usageStatement(env, { now, fingerprint, fresh: 0, userId, tries: 1 }),
  ];
}

/**
 * The params a sender filled, held to the version's declarations and, if
 * it has one, its check() (§3 校验): what is wrong, item by item.
 */
export async function checkMyParams(
  env: ApiBindings,
  userId: string,
  judgeId: string,
  n: number,
  input: JudgeParamsCheckInput,
): Promise<JudgeParamsCheck> {
  const run = await versionToRun(env, userId, judgeId, n, input.params);
  if ("problems" in run.read) return { problems: run.read.problems };
  if (!run.declarations?.check) return { problems: [] };
  await holdTries(env, userId);
  const now = Date.now();
  await env.DB.batch(
    tryStatements(env, userId, "check", run.row.fingerprint, now),
  );
  const outcome = await checkParamsInJudge(
    env,
    { code: await run.code(), fingerprint: run.row.fingerprint, fresh: 0 },
    { params: run.read.values, hongbao: triedHongbao(input.hongbao) },
  );
  if ("failure" in outcome) return { failure: outcome.detail };
  const answer = readCheckAnswer(outcome.answer, run.declarations.params);
  return "invalid" in answer ? { failure: answer.invalid } : answer;
}

/**
 * 试一试 (§6): one judgment by a made-up claimant — level 2, their first
 * submission — on the 红包 as filled in, with these params: no money, no
 * record. A 联网 version's requests get no answer here.
 */
export async function tryMyJudge(
  env: ApiBindings,
  userId: string,
  judgeId: string,
  n: number,
  input: JudgeTryInput,
): Promise<JudgeTry> {
  const run = await versionToRun(env, userId, judgeId, n, input.params);
  if ("problems" in run.read)
    throw new ActivityError(
      400,
      "JUDGE_PARAMS_INVALID",
      run.read.problems[0]?.message ?? "参数没填好",
    );
  await holdTries(env, userId);
  const now = Date.now();
  await env.DB.batch(
    tryStatements(env, userId, "try", run.row.fingerprint, now),
  );
  const secret = Array.from(
    crypto.getRandomValues(new Uint8Array(32)),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
  const scenario = startScenario({
    hongbao: {
      ...triedHongbao(input.hongbao),
      openedAt: now - 3_600_000,
      endsAt: now + 86_400_000,
    },
    hongbaoId: "try",
    secret,
    params: run.read.values,
    protocol: JUDGE_PROTOCOL,
  });
  const user = { id: 10000, username: "tester", level: 2 as const };
  const submission = nextSubmission(scenario, {
    input: input.input,
    now,
    user,
  });
  const outcome = await runJudge(
    env,
    {
      code: await run.code(),
      fingerprint: run.row.fingerprint,
      submission,
      seeds: {
        submission: submissionSeed("try", secret, user.id, 0),
        user: userSeed("try", secret, user.id),
      },
      network: { mode: "mock", list: listOf(run.row.network), answers: [] },
    },
    true,
  );
  if ("failure" in outcome)
    return outcome.failure === "timeout"
      ? { failure: "timeout", detail: outcome.detail }
      : { failure: "error", detail: outcome.detail };
  const reading = readVerdict(
    outcome.verdict,
    submission.share,
    JUDGE_PROTOCOL,
  );
  if ("error" in reading)
    return { failure: "error", detail: reading.error.detail };
  // Protocol 5: nobody else has played here, so others name no one.
  if ("add" in reading) {
    const problem = othersProblem(reading.others, user.id, () => "unknown");
    if (problem) return { failure: "error", detail: problem };
    const { unclaimed } = submission.hongbao;
    const after =
      moveMoney(unclaimed, [{ id: 0, pending: 0, add: reading.add }]).moves[0]
        ?.after ?? 0;
    return {
      judged: true,
      added: after,
      settled: reading.settle || reading.end || after === unclaimed,
      ...(reading.message ? { message: reading.message } : {}),
    };
  }
  return reading.ok
    ? {
        ok: true,
        amount: reading.paid,
        ...(reading.message ? { message: reading.message } : {}),
      }
    : { ok: false, ...(reading.message ? { message: reading.message } : {}) };
}

/**
 * The 红包 as filled in, as protocol 5 tells the code (§3.5): no shares,
 * the compatible count and 0.01, whatever the page sent.
 */
function triedHongbao(hongbao: JudgeTryInput["hongbao"]) {
  return {
    title: hongbao.title,
    total: hongbao.total,
    count: defaultCount(hongbao.total),
    minEach: 1,
  };
}

/** 判定器页's settings (§2, §14.4): its code only ever goes public. */
export async function updateMyJudge(
  env: ApiBindings,
  userId: string,
  judgeId: string,
  input: UpdateJudgeInput,
) {
  const row = await ownJudge(env, judgeId, userId);
  if (row.code_public === "always" && input.codePublic !== "always")
    throw new ActivityError(
      409,
      "JUDGE_CODE_PUBLIC",
      "代码已经一直公开，改不回来。",
    );
  await env.DB.prepare(
    "UPDATE judges SET name = ?, description = ?, code_public = ?, updated_at = ? WHERE id = ?",
  )
    .bind(input.name, input.description, input.codePublic, Date.now(), judgeId)
    .run();
  return getMyJudge(env, userId, judgeId);
}

/** A draft saved with its 判定器's name and line as typed: kept on it. */
export function renameStatement(
  env: ApiBindings,
  judgeId: string,
  userId: string,
  name: string,
  description: string,
) {
  return env.DB.prepare(
    "UPDATE judges SET name = ?, description = ?, updated_at = MAX(updated_at, ?) WHERE id = ? AND author_id = ? AND (name IS NOT ? OR description IS NOT ?)",
  ).bind(name, description, Date.now(), judgeId, userId, name, description);
}

type LegacyRow = {
  activity_id: string;
  author_id: string;
  title: string;
  opened_at: number | null;
  created_at: number;
  protocol: number;
  fingerprint: string;
  code_ciphertext: string;
  tests_ciphertext: string;
  tests_digest: string;
  versions_ciphertext: string | null;
  network: string | null;
};

/**
 * A 红包 sent before 判定器 (§14.3), moved into one of its own: named after
 * its title, with the versions whose code it kept — the code it has, and
 * the one 换回 would put back — each with its tests as they are now and
 * whether its sender's run of them passed. An opened one keeps the version
 * it opened with. A draft that kept no code beyond its own new code has
 * nothing to move: it just stops being one from before.
 */
async function migrateOne(env: ApiBindings, row: LegacyRow) {
  const [code, tests, versions] = await Promise.all([
    decryptString(row.code_ciphertext, env, judgeData(row.activity_id, "code")),
    decryptString(
      row.tests_ciphertext,
      env,
      judgeData(row.activity_id, "tests"),
    ),
    row.versions_ciphertext === null
      ? null
      : decryptString(
          row.versions_ciphertext,
          env,
          judgeData(row.activity_id, "versions"),
        ).then((text) => JSON.parse(text) as JudgeVersions),
  ]);
  const listed = versions?.versions ?? [];
  // The code each version kept: this draft's own, and the one to put back.
  const codes = new Map<string, string>([[row.fingerprint, code]]);
  if (versions?.restore)
    codes.set(await textDigest(versions.restore.code), versions.restore.code);
  const opened = row.opened_at !== null;
  const kept = opened
    ? [
        {
          n:
            listed.find((version) => version.fingerprint === row.fingerprint)
              ?.n ?? 1,
          fingerprint: row.fingerprint,
          at: row.created_at,
        },
      ]
    : listed
        .filter((version) => codes.has(version.fingerprint))
        .map((version) => ({
          n: version.n,
          fingerprint: version.fingerprint,
          at: Date.parse(version.at),
        }));
  if (kept.length === 0) {
    await env.DB.prepare(
      "UPDATE activity_code SET versions_ciphertext = NULL WHERE activity_id = ? AND judge_id IS NULL",
    )
      .bind(row.activity_id)
      .run();
    return;
  }
  kept.sort((a, b) => a.n - b.n);
  const judgeId = crypto.randomUUID();
  const now = Date.now();
  const name =
    Array.from(row.title.trim()).slice(0, 20).join("").trim() || "判定器";
  const statements = [
    env.DB.prepare(
      "INSERT INTO judges (id, author_id, name, description, created_at, updated_at) VALUES (?, ?, ?, '', ?, ?)",
    ).bind(judgeId, row.author_id, name, now, now),
  ];
  for (const version of kept) {
    // Its tests as they are now; passed if its sender's run of them did,
    // on the newest protocol that ran them.
    const run = opened
      ? { protocol: row.protocol, passed: 1 }
      : await env.DB.prepare(
          `SELECT protocol, passed FROM judge_checks WHERE user_id = ? AND fingerprint = ? AND tests_digest = ?
            AND finished_at IS NOT NULL ORDER BY protocol DESC, passed DESC LIMIT 1`,
        )
          .bind(row.author_id, version.fingerprint, row.tests_digest)
          .first<{ protocol: number; passed: number }>();
    const deployedAt = Number.isFinite(version.at) ? version.at : now;
    statements.push(
      env.DB.prepare(`INSERT INTO judge_versions (judge_id, n, fingerprint, code_ciphertext, protocol,
          tests_ciphertext, tests_digest, passed, network, deployed_at, checked_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(
        judgeId,
        version.n,
        version.fingerprint,
        await encryptString(
          codes.get(version.fingerprint) ?? code,
          env,
          versionData(judgeId, version.n, "code"),
        ),
        run?.protocol ?? 1,
        await encryptString(
          tests,
          env,
          versionData(judgeId, version.n, "tests"),
        ),
        row.tests_digest,
        run?.passed ?? 0,
        opened && row.protocol >= 2 ? row.network : null,
        deployedAt,
        Math.max(deployedAt, now),
      ),
    );
  }
  const own = kept.find((version) => version.fingerprint === row.fingerprint);
  statements.push(
    env.DB.prepare(
      `UPDATE activity_code SET judge_id = ?, judge_version = ?${opened ? "" : ", versions_ciphertext = NULL"}
        WHERE activity_id = ? AND judge_id IS NULL`,
    ).bind(judgeId, own?.n ?? null, row.activity_id),
  );
  await env.DB.batch(statements);
}

const LEGACY = `SELECT c.activity_id, a.author_id, a.title, a.opened_at, c.created_at, c.protocol,
    c.fingerprint, c.code_ciphertext, c.tests_ciphertext, c.tests_digest, c.versions_ciphertext, c.network
  FROM activity_code c JOIN activities a ON a.id = c.activity_id
  WHERE c.judge_id IS NULL AND (a.opened_at IS NOT NULL
    OR (c.versions_ciphertext IS NOT NULL AND a.deleted_at IS NULL))`;

/**
 * 红包 sent before 判定器 moved over (§14.3): one, a person's, or (the
 * maintenance task) the next few. One that fails is left for the next
 * time, the rest go on.
 */
export async function migrateJudgesOf(
  env: ApiBindings,
  scope: { activityId?: string; userId?: string } = {},
) {
  const rows = (
    scope.activityId
      ? await env.DB.prepare(`${LEGACY} AND c.activity_id = ?`)
          .bind(scope.activityId)
          .all<LegacyRow>()
      : scope.userId
        ? await env.DB.prepare(`${LEGACY} AND a.author_id = ?`)
            .bind(scope.userId)
            .all<LegacyRow>()
        : await env.DB.prepare(`${LEGACY} ORDER BY c.created_at LIMIT ?`)
            .bind(MIGRATED_A_RUN)
            .all<LegacyRow>()
  ).results;
  let moved = 0;
  for (const row of rows) {
    try {
      await migrateOne(env, row);
      moved += 1;
    } catch (error) {
      console.error("judge_migration_failed", {
        activityId: row.activity_id,
        errorName: error instanceof Error ? error.name : typeof error,
      });
    }
  }
  return { moved, left: rows.length - moved };
}
