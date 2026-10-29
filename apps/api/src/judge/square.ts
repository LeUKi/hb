// 判定器广场 (docs/judge-square-design.md §8, §15): 判定器 their authors
// put in it, each with its numbers and the version others use — the one
// 站长精选 has, else the newest that passed on protocol 3 or later and
// opened a 红包. Anyone may look; a 判定器 out of it opens only to its
// author, the 站长, and whoever has a 红包 with it.
import {
  JUDGE_OLDEST_PROTOCOL,
  type JudgeDeclarations,
  type JudgeListingInput,
  type JudgePage,
  type JudgePageVersion,
  type JudgeSource,
  type JudgeStats,
  type SquareJudge,
  type SquareJudgeList,
} from "@hb/contracts";
import { ActivityError } from "../activities/errors";
import { isAdministrator } from "../admin/authorization";
import type { ApiBindings } from "../env";
import { decryptString } from "../security/crypto";
import { ownJudge, versionData } from "./judges";
import { readJudgeSettings } from "./settings";

/** Cards a page of 大家做的. */
const PAGE_SIZE = 20;

/** 红包 that count (§15.3): opened, and not stopped by the 站长. */
const COUNTED = `a.opened_at IS NOT NULL AND c.stopped_at IS NULL`;

/** The version others use: newest that passed and opened a 红包 that counts. */
const PUBLIC_N = (judge: string) => `(SELECT MAX(v.n) FROM judge_versions v
  WHERE v.judge_id = ${judge} AND v.passed = 1 AND v.protocol >= ${JUDGE_OLDEST_PROTOCOL}
    AND EXISTS(SELECT 1 FROM activity_code c JOIN activities a ON a.id = c.activity_id
      WHERE c.judge_id = v.judge_id AND c.judge_version = v.n AND ${COUNTED}))`;

/**
 * Every 判定器's numbers worked out again (the maintenance task): adding
 * at each claim would have to take a 停用 红包 back out (§15.2).
 */
export async function refreshJudgeStats(env: ApiBindings, now = Date.now()) {
  await env.DB.prepare(`INSERT INTO judge_stats (judge_id, hongbao, judged, claimed, last_opened_at, public_n, refreshed_at)
    SELECT j.id, COUNT(a.id),
      COALESCE(SUM((SELECT COALESCE(MAX(x.sequence) + 1, 0) FROM code_judgments x WHERE x.activity_id = a.id)), 0),
      COALESCE(SUM(a.claimed_count), 0), MAX(a.opened_at), ${PUBLIC_N("j.id")}, ?1
    FROM judges j
    LEFT JOIN activity_code c ON c.judge_id = j.id AND c.stopped_at IS NULL
    LEFT JOIN activities a ON a.id = c.activity_id AND a.opened_at IS NOT NULL
    GROUP BY j.id
    ON CONFLICT(judge_id) DO UPDATE SET hongbao = excluded.hongbao, judged = excluded.judged,
      claimed = excluded.claimed, last_opened_at = excluded.last_opened_at,
      public_n = excluded.public_n, refreshed_at = excluded.refreshed_at`)
    .bind(now)
    .run();
}

/** The version others use now, read live (a page, picking, opening). */
export async function publicVersionOf(env: ApiBindings, judgeId: string) {
  const row = await env.DB.prepare(
    `SELECT COALESCE((SELECT f.n FROM judge_features f WHERE f.judge_id = ?1), ${PUBLIC_N("?1")}) AS n`,
  )
    .bind(judgeId)
    .first<{ n: number | null }>();
  return row?.n ?? null;
}

type CardRow = {
  id: string;
  name: string;
  description: string;
  username: string;
  displayName: string;
  avatarUrl: string | null;
  provider: string;
  externalId: string;
  basedOnId: string | null;
  basedOnUsername: string | null;
  basedOnDisplayName: string | null;
  basedOnAvatarUrl: string | null;
  basedOnListed: number | null;
  featured: number;
  network: number;
  hongbao: number | null;
  judged: number | null;
  claimed: number | null;
  lastOpenedAt: number | null;
};

/** A card's columns; `version` the expression for the version others use. */
const CARD = (version: string) => `j.id, j.name, j.description,
  u.username, u.display_name AS displayName, u.avatar_url AS avatarUrl,
  u.provider, u.external_id AS externalId, b.id AS basedOnId, bu.username AS basedOnUsername, bu.display_name AS basedOnDisplayName,
  bu.avatar_url AS basedOnAvatarUrl,
  (b.listed_at IS NOT NULL AND b.taken_down_at IS NULL) AS basedOnListed,
  EXISTS(SELECT 1 FROM judge_features ff WHERE ff.judge_id = j.id) AS featured,
  EXISTS(SELECT 1 FROM judge_versions nv WHERE nv.judge_id = j.id AND nv.n = ${version}
    AND nv.network IS NOT NULL) AS network,
  s.hongbao, s.judged, s.claimed, s.last_opened_at AS lastOpenedAt`;
const CARD_JOINS = `JOIN users u ON u.id = j.author_id
  LEFT JOIN judges b ON b.id = j.based_on_judge_id LEFT JOIN users bu ON bu.id = b.author_id
  LEFT JOIN judge_stats s ON s.judge_id = j.id`;

const statsOf = (row: {
  hongbao: number | null;
  judged: number | null;
  claimed: number | null;
}): JudgeStats => ({
  hongbao: row.hongbao ?? 0,
  judged: row.judged ?? 0,
  claimed: row.claimed ?? 0,
});

function cardOf(env: ApiBindings, row: CardRow): SquareJudge {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    author: {
      username: row.username,
      displayName: row.displayName,
      avatarUrl: row.avatarUrl,
    },
    basedOn:
      row.basedOnId && row.basedOnUsername && row.basedOnDisplayName
        ? {
            id: row.basedOnId,
            username: row.basedOnUsername,
            displayName: row.basedOnDisplayName,
            avatarUrl: row.basedOnAvatarUrl,
            listed: row.basedOnListed === 1,
          }
        : null,
    featured: row.featured === 1,
    bySiteOwner: isAdministrator(env, row.provider, row.externalId),
    network: row.network === 1,
    stats: statsOf(row),
  };
}

/** In the 广场: listed, and not taken down. */
const IN_SQUARE = "j.listed_at IS NOT NULL AND j.taken_down_at IS NULL";

type Cursor = { h: number; t: number; id: string };

function readCursor(value: string | undefined, sort: "recent" | "used") {
  if (!value) return null;
  try {
    const parsed = JSON.parse(atob(value)) as Partial<Cursor> & {
      sort?: string;
    };
    if (
      parsed.sort === sort &&
      typeof parsed.h === "number" &&
      typeof parsed.t === "number" &&
      typeof parsed.id === "string"
    )
      return { h: parsed.h, t: parsed.t, id: parsed.id };
  } catch {}
  throw new ActivityError(400, "INVALID_CURSOR", "分页位置无效");
}

/**
 * 站长精选 in its order, or 大家做的 — those with a version that opened a
 * 红包 — by the latest opening (最近) or 红包 sent (用得最多, §15.5).
 */
export async function listSquareJudges(
  env: ApiBindings,
  query: { tab: "featured" | "all"; sort: "recent" | "used"; cursor?: string },
): Promise<SquareJudgeList> {
  const { networkEnabled } = await readJudgeSettings(env);
  if (query.tab === "featured") {
    const rows = (
      await env.DB.prepare(`SELECT ${CARD("f.n")} FROM judge_features f JOIN judges j ON j.id = f.judge_id
        ${CARD_JOINS} WHERE ${IN_SQUARE} ORDER BY f.position, f.created_at`).all<CardRow>()
    ).results;
    return {
      items: rows
        .filter((row) => networkEnabled || row.network !== 1)
        .map((row) => cardOf(env, row)),
      nextCursor: null,
    };
  }
  const cursor = readCursor(query.cursor, query.sort);
  const order =
    query.sort === "used"
      ? "s.hongbao DESC, s.last_opened_at DESC, j.id DESC"
      : "s.last_opened_at DESC, j.id DESC";
  const after = !cursor
    ? ""
    : query.sort === "used"
      ? `AND (s.hongbao < ?1 OR (s.hongbao = ?1 AND (s.last_opened_at < ?2
          OR (s.last_opened_at = ?2 AND j.id < ?3))))`
      : "AND (s.last_opened_at < ?2 OR (s.last_opened_at = ?2 AND j.id < ?3))";
  // With 联网 switched off, none that goes online (§15.3).
  const statement =
    env.DB.prepare(`SELECT ${CARD("s.public_n")} FROM judges j ${CARD_JOINS}
      WHERE ${IN_SQUARE} AND s.public_n IS NOT NULL ${after}
        ${networkEnabled ? "" : "AND NOT EXISTS(SELECT 1 FROM judge_versions nv WHERE nv.judge_id = j.id AND nv.n = s.public_n AND nv.network IS NOT NULL)"}
      ORDER BY ${order} LIMIT ${PAGE_SIZE + 1}`);
  const rows = (
    await (cursor
      ? statement.bind(cursor.h, cursor.t, cursor.id)
      : statement
    ).all<CardRow>()
  ).results;
  const page = rows.slice(0, PAGE_SIZE);
  const last = page.at(-1);
  return {
    items: page.map((row) => cardOf(env, row)),
    nextCursor:
      rows.length > PAGE_SIZE && last
        ? btoa(
            JSON.stringify({
              sort: query.sort,
              h: last.hongbao ?? 0,
              t: last.lastOpenedAt ?? 0,
              id: last.id,
            }),
          )
        : null,
  };
}

type Viewer = { id: string; isAdmin: boolean } | null;

type PageRow = CardRow & {
  authorId: string;
  codePublic: "ended" | "always";
  listedAt: number | null;
  takenDownAt: number | null;
  takenDownReason: string | null;
};

/**
 * A 判定器 as this person may see it (§15.3): in the 广场, their own, any
 * to the 站长, or one they have a 红包 with; 未找到 otherwise.
 */
async function visibleJudge(env: ApiBindings, judgeId: string, viewer: Viewer) {
  const row = await env.DB.prepare(`SELECT ${CARD(
    "COALESCE((SELECT f.n FROM judge_features f WHERE f.judge_id = j.id), s.public_n)",
  )}, j.author_id AS authorId, j.code_public AS codePublic, j.listed_at AS listedAt,
      j.taken_down_at AS takenDownAt, j.taken_down_reason AS takenDownReason
    FROM judges j ${CARD_JOINS} WHERE j.id = ?1`)
    .bind(judgeId)
    .first<PageRow>();
  const listed = row?.listedAt != null && row.takenDownAt === null;
  const own = Boolean(row && viewer && row.authorId === viewer.id);
  const used =
    row &&
    viewer &&
    !listed &&
    !own &&
    (await env.DB.prepare(
      `SELECT 1 FROM activity_code c JOIN activities a ON a.id = c.activity_id
        WHERE c.judge_id = ? AND a.author_id = ? AND a.deleted_at IS NULL LIMIT 1`,
    )
      .bind(judgeId, viewer.id)
      .first());
  if (!row || !(listed || own || viewer?.isAdmin || used))
    throw new ActivityError(404, "JUDGE_NOT_FOUND", "未找到判定器");
  return { row, listed, own };
}

/** The versions that opened a 红包 that counts, newest first (§8 版本). */
async function openedVersions(
  env: ApiBindings,
  judgeId: string,
): Promise<JudgePageVersion[]> {
  return (
    await env.DB.prepare(
      `SELECT v.n, v.deployed_at AS deployedAt, COUNT(*) AS opened FROM judge_versions v
        JOIN activity_code c ON c.judge_id = v.judge_id AND c.judge_version = v.n
        JOIN activities a ON a.id = c.activity_id
        WHERE v.judge_id = ? AND ${COUNTED} GROUP BY v.n ORDER BY v.n DESC`,
    )
      .bind(judgeId)
      .all<{ n: number; deployedAt: number; opened: number }>()
  ).results.map((row) => ({
    n: row.n,
    deployedAt: new Date(row.deployedAt).toISOString(),
    opened: row.opened,
  }));
}

/** 判定器页 (§8): for anyone it is open to. */
export async function judgePage(
  env: ApiBindings,
  judgeId: string,
  viewer: Viewer,
): Promise<JudgePage> {
  const { row, listed, own } = await visibleJudge(env, judgeId, viewer);
  const [n, versions] = await Promise.all([
    publicVersionOf(env, judgeId),
    openedVersions(env, judgeId),
  ]);
  const version =
    n === null
      ? null
      : await env.DB.prepare(
          "SELECT n, fingerprint, deployed_at, declarations, network, code_ciphertext FROM judge_versions WHERE judge_id = ? AND n = ?",
        )
          .bind(judgeId, n)
          .first<{
            n: number;
            fingerprint: string;
            deployed_at: number;
            declarations: string | null;
            network: string | null;
            code_ciphertext: string;
          }>();
  // Its code only when public (§2), or to its author.
  const shown = own || row.codePublic === "always";
  return {
    ...cardOf(env, row),
    own,
    listed,
    codePublic: row.codePublic,
    version: version
      ? {
          n: version.n,
          fingerprint: version.fingerprint,
          deployedAt: new Date(version.deployed_at).toISOString(),
          declarations:
            version.declarations === null
              ? null
              : (JSON.parse(version.declarations) as JudgeDeclarations),
          network:
            version.network === null
              ? null
              : (JSON.parse(version.network) as string[]),
          code: shown
            ? await decryptString(
                version.code_ciphertext,
                env,
                versionData(judgeId, version.n, "code"),
              )
            : null,
        }
      : null,
    versions,
    ...(viewer?.isAdmin &&
    row.takenDownAt !== null &&
    row.takenDownReason !== null
      ? {
          takenDown: {
            at: new Date(row.takenDownAt).toISOString(),
            reason: row.takenDownReason,
          },
        }
      : {}),
  };
}

/**
 * One version's code on 判定器页 (§8 版本), and what it declares: one that
 * opened a 红包 or the 精选 one, of a 判定器 whose code is public; any of
 * one's own.
 */
export async function judgePageCode(
  env: ApiBindings,
  judgeId: string,
  n: number,
  viewer: Viewer,
) {
  const { row, own } = await visibleJudge(env, judgeId, viewer);
  const opened =
    own ||
    (await openedVersions(env, judgeId)).some((version) => version.n === n) ||
    (await publicVersionOf(env, judgeId)) === n;
  const version = await env.DB.prepare(
    "SELECT fingerprint, code_ciphertext, declarations, network FROM judge_versions WHERE judge_id = ? AND n = ?",
  )
    .bind(judgeId, n)
    .first<{
      fingerprint: string;
      code_ciphertext: string;
      declarations: string | null;
      network: string | null;
    }>();
  if (!version || !opened || !(own || row.codePublic === "always"))
    throw new ActivityError(404, "JUDGE_NOT_FOUND", "未找到判定器");
  return {
    fingerprint: version.fingerprint,
    code: await decryptString(
      version.code_ciphertext,
      env,
      versionData(judgeId, n, "code"),
    ),
    declarations:
      version.declarations === null
        ? null
        : (JSON.parse(version.declarations) as JudgeDeclarations),
    network:
      version.network === null
        ? null
        : (JSON.parse(version.network) as string[]),
  };
}

/** Whether this person may see the 红包 a 判定器 opened (the page's list). */
export async function canSeeJudge(
  env: ApiBindings,
  judgeId: string,
  viewer: Viewer,
) {
  await visibleJudge(env, judgeId, viewer);
}

/**
 * 加入判定器广场 (§8, §15.4): its code public for good once it joins, and
 * not while the 站长 has it taken down; 允许站长选入精选 any time.
 */
export async function setMyJudgeListing(
  env: ApiBindings,
  userId: string,
  judgeId: string,
  input: JudgeListingInput,
) {
  const judge = await ownJudge(env, judgeId, userId);
  const takenDown =
    (await env.DB.prepare("SELECT taken_down_at FROM judges WHERE id = ?")
      .bind(judgeId)
      .first<number | null>("taken_down_at")) !== null;
  if (input.listed && takenDown)
    throw new ActivityError(
      409,
      "JUDGE_TAKEN_DOWN",
      "这个判定器已被站长撤下，不能再加入。",
    );
  const now = Date.now();
  await env.DB.prepare(
    `UPDATE judges SET featurable = ?1,
      code_public = CASE WHEN ?2 THEN 'always' ELSE code_public END,
      listed_at = CASE WHEN ?2 THEN COALESCE(listed_at, ?3) ELSE NULL END,
      updated_at = MAX(updated_at, ?3) WHERE id = ?4`,
  )
    .bind(Number(input.featurable), Number(input.listed), now, judge.id)
    .run();
}

/**
 * Whether others may use this version (§15.3): one that passed on a
 * protocol 红包 still open on (JUDGE_OLDEST_PROTOCOL on), and is the 精选
 * one or opened a 红包 that counts.
 */
export async function usableByOthers(
  env: ApiBindings,
  judgeId: string,
  n: number,
) {
  return Boolean(
    await env.DB.prepare(
      `SELECT 1 FROM judge_versions v WHERE v.judge_id = ?1 AND v.n = ?2 AND v.passed = 1
        AND v.protocol >= ${JUDGE_OLDEST_PROTOCOL}
        AND (EXISTS(SELECT 1 FROM judge_features f WHERE f.judge_id = v.judge_id AND f.n = v.n)
          OR EXISTS(SELECT 1 FROM activity_code c JOIN activities a ON a.id = c.activity_id
            WHERE c.judge_id = v.judge_id AND c.judge_version = v.n AND ${COUNTED}))`,
    )
      .bind(judgeId, n)
      .first(),
  );
}

/** Who wrote a 红包's 判定器, whose passing run it opens with; null before 判定器. */
export async function judgeAuthorOf(env: ApiBindings, judgeId: string | null) {
  if (!judgeId) return null;
  return env.DB.prepare("SELECT author_id FROM judges WHERE id = ?")
    .bind(judgeId)
    .first<string>("author_id");
}

/**
 * Another's 判定器 for a draft (§15.3): the version's code and tests, to
 * be kept with it — in the 广场 and a version others may use, or the one
 * this draft has already (its author since left the 广场, or the 站长
 * took it down: kept, though it will not open). Null for one's own.
 */
export async function borrowedVersion(
  env: ApiBindings,
  activityId: string,
  authorId: string,
  judgeId: string,
  n: number | undefined,
) {
  const judge = await env.DB.prepare(
    "SELECT author_id, listed_at, taken_down_at FROM judges WHERE id = ?",
  )
    .bind(judgeId)
    .first<{
      author_id: string;
      listed_at: number | null;
      taken_down_at: number | null;
    }>();
  if (judge?.author_id === authorId) return null;
  const kept =
    n !== undefined &&
    (await env.DB.prepare(
      "SELECT 1 FROM activity_code WHERE activity_id = ? AND judge_id = ? AND judge_version = ?",
    )
      .bind(activityId, judgeId, n)
      .first());
  const usable =
    judge &&
    n !== undefined &&
    judge.listed_at !== null &&
    judge.taken_down_at === null &&
    (await usableByOthers(env, judgeId, n));
  if (!judge || n === undefined || !(kept || usable))
    throw new ActivityError(404, "JUDGE_NOT_FOUND", "未找到判定器");
  const version = await env.DB.prepare(
    "SELECT code_ciphertext, tests_ciphertext FROM judge_versions WHERE judge_id = ? AND n = ?",
  )
    .bind(judgeId, n)
    .first<{ code_ciphertext: string; tests_ciphertext: string }>();
  if (!version) throw new ActivityError(404, "JUDGE_NOT_FOUND", "未找到判定器");
  const [code, tests] = await Promise.all([
    decryptString(
      version.code_ciphertext,
      env,
      versionData(judgeId, n, "code"),
    ),
    decryptString(
      version.tests_ciphertext,
      env,
      versionData(judgeId, n, "tests"),
    ),
  ]);
  return { n, code, tests };
}

/**
 * Another's 判定器 as its sender's form shows it (§15.4): whose, whether
 * it is still in the 广场 or taken down, a newer version others use, and
 * what this draft's version declares. Undefined for one's own.
 */
export async function judgeSourceOf(
  env: ApiBindings,
  authorId: string,
  judgeId: string | null,
  n: number | null,
): Promise<JudgeSource | undefined> {
  if (!judgeId || n === null) return undefined;
  const row =
    await env.DB.prepare(`SELECT j.author_id AS authorId, j.listed_at AS listedAt,
      j.taken_down_at AS takenDownAt, u.username, u.display_name AS displayName,
      u.avatar_url AS avatarUrl, u.provider, u.external_id AS externalId, bu.username AS basedOn,
      EXISTS(SELECT 1 FROM judge_features f WHERE f.judge_id = j.id) AS featured,
      v.declarations, v.network
    FROM judges j JOIN users u ON u.id = j.author_id
      LEFT JOIN judges b ON b.id = j.based_on_judge_id LEFT JOIN users bu ON bu.id = b.author_id
      LEFT JOIN judge_versions v ON v.judge_id = j.id AND v.n = ?2
    WHERE j.id = ?1`)
      .bind(judgeId, n)
      .first<{
        authorId: string;
        listedAt: number | null;
        takenDownAt: number | null;
        username: string;
        displayName: string;
        avatarUrl: string | null;
        provider: string;
        externalId: string;
        basedOn: string | null;
        featured: number;
        declarations: string | null;
        network: string | null;
      }>();
  if (!row || row.authorId === authorId) return undefined;
  const current = await publicVersionOf(env, judgeId);
  return {
    author: {
      username: row.username,
      displayName: row.displayName,
      avatarUrl: row.avatarUrl,
    },
    featured: row.featured === 1,
    bySiteOwner: isAdministrator(env, row.provider, row.externalId),
    basedOn: row.basedOn,
    listed: row.listedAt !== null && row.takenDownAt === null,
    takenDown: row.takenDownAt !== null,
    newer: current !== null && current > n ? current : null,
    declarations:
      row.declarations === null
        ? null
        : (JSON.parse(row.declarations) as JudgeDeclarations),
    network:
      row.network === null ? null : (JSON.parse(row.network) as string[]),
  };
}
