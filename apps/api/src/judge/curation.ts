// The 站长's hand on the 判定器广场 (docs/judge-square-design.md §8, §9,
// §15.4): 撤下 with a reason its author reads, 恢复, and 站长精选 — a
// version of a 判定器 in the 广场 its author lets be chosen (or the 站长's
// own), in the 站长's order. Every change is written down for 操作记录.
import type {
  AdminJudgeCuration,
  JudgeFeatureChange,
  JudgeFeatureInput,
  JudgeTakeDownInput,
} from "@hb/contracts";
import { ActivityError } from "../activities/errors";
import { isAdministrator } from "../admin/authorization";
import type { ApiBindings } from "../env";
import { usableByOthers } from "./square";

type Action =
  | "take_down"
  | "restore"
  | "feature"
  | "unfeature"
  | "move"
  | "version";

type JudgeState = {
  id: string;
  name: string;
  author_id: string;
  listed_at: number | null;
  taken_down_at: number | null;
  featurable: number;
};

async function judgeState(env: ApiBindings, judgeId: string) {
  const row = await env.DB.prepare(
    "SELECT id, name, author_id, listed_at, taken_down_at, featurable FROM judges WHERE id = ?",
  )
    .bind(judgeId)
    .first<JudgeState>();
  if (!row) throw new ActivityError(404, "JUDGE_NOT_FOUND", "没有这个判定器");
  return row;
}

function notInSquare(): never {
  throw new ActivityError(
    409,
    "JUDGE_NOT_LISTED",
    "这个判定器不在判定器广场里",
  );
}

/** One line of 操作记录, the 判定器's name as it is now. */
function changeStatement(
  env: ApiBindings,
  change: {
    actorId: string;
    judge: JudgeState;
    action: Action;
    reason?: string;
    n?: number;
    at: number;
  },
) {
  return env.DB.prepare(
    "INSERT INTO judge_square_changes (id, actor_user_id, judge_id, action, name, reason, n, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  ).bind(
    crypto.randomUUID(),
    change.actorId,
    change.judge.id,
    change.action,
    change.judge.name,
    change.reason ?? null,
    change.n ?? null,
    change.at,
  );
}

/**
 * 撤下 (§8): out of the 广场, its drafts kept but not opening, its opened
 * 红包 as they are; its author reads why.
 */
export async function takeDownJudge(
  env: ApiBindings,
  adminId: string,
  judgeId: string,
  input: JudgeTakeDownInput,
) {
  const judge = await judgeState(env, judgeId);
  if (judge.listed_at === null || judge.taken_down_at !== null) notInSquare();
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE judges SET listed_at = NULL, taken_down_at = ?1, taken_down_reason = ?2, taken_down_by = ?3,
        updated_at = MAX(updated_at, ?1) WHERE id = ?4 AND taken_down_at IS NULL`,
    ).bind(now, input.reason, adminId, judgeId),
    changeStatement(env, {
      actorId: adminId,
      judge,
      action: "take_down",
      reason: input.reason,
      at: now,
    }),
  ]);
}

/** 恢复 (§15.5): back in the 广场, its drafts opening again. */
export async function restoreJudge(
  env: ApiBindings,
  adminId: string,
  judgeId: string,
) {
  const judge = await judgeState(env, judgeId);
  if (judge.taken_down_at === null)
    throw new ActivityError(
      409,
      "JUDGE_NOT_TAKEN_DOWN",
      "这个判定器没有被撤下",
    );
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE judges SET taken_down_at = NULL, taken_down_reason = NULL, taken_down_by = NULL,
        listed_at = ?1, updated_at = MAX(updated_at, ?1) WHERE id = ?2`,
    ).bind(now, judgeId),
    changeStatement(env, {
      actorId: adminId,
      judge,
      action: "restore",
      at: now,
    }),
  ]);
}

/** A version the 精选 may have: one others may use, or the 站长's own that passed. */
async function featurableVersion(
  env: ApiBindings,
  judge: JudgeState,
  adminId: string,
  n: number,
) {
  const ok =
    judge.author_id === adminId
      ? await env.DB.prepare(
          "SELECT 1 FROM judge_versions WHERE judge_id = ? AND n = ? AND passed = 1 AND protocol = 3",
        )
          .bind(judge.id, n)
          .first()
      : await usableByOthers(env, judge.id, n);
  if (!ok)
    throw new ActivityError(
      409,
      "JUDGE_VERSION_UNUSABLE",
      "这一版不能选入精选",
    );
}

/** 选入精选 (§9): last in the order. */
export async function featureJudge(
  env: ApiBindings,
  adminId: string,
  input: JudgeFeatureInput,
) {
  const judge = await judgeState(env, input.judgeId);
  if (judge.listed_at === null || judge.taken_down_at !== null) notInSquare();
  if (judge.featurable !== 1 && judge.author_id !== adminId)
    throw new ActivityError(
      409,
      "JUDGE_NOT_FEATURABLE",
      "作者没有允许选入精选",
    );
  if (
    await env.DB.prepare("SELECT 1 FROM judge_features WHERE judge_id = ?")
      .bind(judge.id)
      .first()
  )
    throw new ActivityError(409, "JUDGE_FEATURED", "已经在精选里了");
  await featurableVersion(env, judge, adminId, input.n);
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO judge_features (judge_id, n, position, created_by, created_at, updated_at)
        VALUES (?1, ?2, (SELECT COALESCE(MAX(position) + 1, 0) FROM judge_features), ?3, ?4, ?4)`,
    ).bind(judge.id, input.n, adminId, now),
    changeStatement(env, {
      actorId: adminId,
      judge,
      action: "feature",
      n: input.n,
      at: now,
    }),
  ]);
}

/** 移出精选. */
export async function unfeatureJudge(
  env: ApiBindings,
  adminId: string,
  judgeId: string,
) {
  const judge = await judgeState(env, judgeId);
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare("DELETE FROM judge_features WHERE judge_id = ?").bind(
      judgeId,
    ),
    changeStatement(env, {
      actorId: adminId,
      judge,
      action: "unfeature",
      at: now,
    }),
  ]);
}

/** 上移, 下移 (swapping places with its neighbour), or 换成第 N 版. */
export async function changeFeature(
  env: ApiBindings,
  adminId: string,
  judgeId: string,
  change: JudgeFeatureChange,
) {
  const judge = await judgeState(env, judgeId);
  const row = await env.DB.prepare(
    "SELECT position FROM judge_features WHERE judge_id = ?",
  )
    .bind(judgeId)
    .first<{ position: number }>();
  if (!row) throw new ActivityError(404, "JUDGE_NOT_FEATURED", "不在精选里");
  const now = Date.now();
  if ("n" in change) {
    await featurableVersion(env, judge, adminId, change.n);
    await env.DB.batch([
      env.DB.prepare(
        "UPDATE judge_features SET n = ?, updated_at = ? WHERE judge_id = ?",
      ).bind(change.n, now, judgeId),
      changeStatement(env, {
        actorId: adminId,
        judge,
        action: "version",
        n: change.n,
        at: now,
      }),
    ]);
    return;
  }
  const neighbour = await env.DB.prepare(
    change.move === "up"
      ? "SELECT judge_id, position FROM judge_features WHERE position < ? ORDER BY position DESC LIMIT 1"
      : "SELECT judge_id, position FROM judge_features WHERE position > ? ORDER BY position LIMIT 1",
  )
    .bind(row.position)
    .first<{ judge_id: string; position: number }>();
  if (!neighbour) return;
  await env.DB.batch([
    env.DB.prepare(
      "UPDATE judge_features SET position = ?, updated_at = ? WHERE judge_id = ?",
    ).bind(neighbour.position, now, judgeId),
    env.DB.prepare(
      "UPDATE judge_features SET position = ?, updated_at = ? WHERE judge_id = ?",
    ).bind(row.position, now, neighbour.judge_id),
    changeStatement(env, { actorId: adminId, judge, action: "move", at: now }),
  ]);
}

type PersonColumns = {
  username: string;
  displayName: string;
  avatarUrl: string | null;
  provider: string;
  externalId: string;
};

/** 精选 in its order and 已撤下, newest first (网站管理 › 判定器). */
export async function judgeCuration(
  env: ApiBindings,
): Promise<AdminJudgeCuration> {
  const [features, takenDown] = await Promise.all([
    env.DB.prepare(`SELECT f.judge_id AS judgeId, f.n, j.name,
        (j.listed_at IS NOT NULL AND j.taken_down_at IS NULL) AS listed,
        u.username, u.display_name AS displayName, u.avatar_url AS avatarUrl,
        u.provider, u.external_id AS externalId, bu.username AS basedOn
      FROM judge_features f JOIN judges j ON j.id = f.judge_id JOIN users u ON u.id = j.author_id
        LEFT JOIN judges b ON b.id = j.based_on_judge_id LEFT JOIN users bu ON bu.id = b.author_id
      ORDER BY f.position, f.created_at`).all<
      PersonColumns & {
        judgeId: string;
        n: number;
        name: string;
        listed: number;
        basedOn: string | null;
      }
    >(),
    env.DB.prepare(`SELECT j.id AS judgeId, j.name, j.taken_down_reason AS reason,
        j.taken_down_at AS at, u.username, u.display_name AS displayName, u.avatar_url AS avatarUrl,
        u.provider, u.external_id AS externalId
      FROM judges j JOIN users u ON u.id = j.author_id
      WHERE j.taken_down_at IS NOT NULL ORDER BY j.taken_down_at DESC`).all<
      PersonColumns & {
        judgeId: string;
        name: string;
        reason: string;
        at: number;
      }
    >(),
  ]);
  const person = (row: PersonColumns) => ({
    username: row.username,
    displayName: row.displayName,
    avatarUrl: row.avatarUrl,
  });
  return {
    features: await Promise.all(
      features.results.map(async (row) => {
        // The newest others may use (精选 aside): 作者有第 N 版.
        const current = await env.DB.prepare(
          `SELECT MAX(v.n) AS n FROM judge_versions v WHERE v.judge_id = ? AND v.n > ? AND v.passed = 1
            AND v.protocol >= 3 AND EXISTS(SELECT 1 FROM activity_code c JOIN activities a ON a.id = c.activity_id
              WHERE c.judge_id = v.judge_id AND c.judge_version = v.n AND a.opened_at IS NOT NULL AND c.stopped_at IS NULL)`,
        )
          .bind(row.judgeId, row.n)
          .first<{ n: number | null }>();
        return {
          judgeId: row.judgeId,
          name: row.name,
          author: person(row),
          bySiteOwner: isAdministrator(env, row.provider, row.externalId),
          basedOn: row.basedOn,
          n: row.n,
          newer: current?.n ?? null,
          listed: row.listed === 1,
        };
      }),
    ),
    takenDown: takenDown.results.map((row) => ({
      judgeId: row.judgeId,
      name: row.name,
      author: person(row),
      reason: row.reason,
      at: new Date(row.at).toISOString(),
    })),
  };
}
