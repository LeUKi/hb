// 三方积分 systems (docs/third-party-points-design.md §1 §6 §7): a PLUS
// member registers one, self-tests it, submits it; the 站长 lets it online,
// sends it back, pauses, resumes or retires it. Words change any time and
// are logged once it has been submitted; the endpoint and 最小单位 change
// only off line, and need a new self-test and review.
import {
  normalizePointsBaseUrl,
  POINTS_COPY_FIELDS,
  POINTS_LIMITS,
  type PointsSystemConfig,
  type PointsSystemStatus,
  type PublicPointsSystem,
} from "@hb/contracts";
import { ActivityError } from "../activities/errors";
import { transferAccess } from "../balance/transfers";
import type { ApiBindings } from "../env";

export type PointsSystemRow = {
  id: string;
  owner_id: string;
  status: PointsSystemStatus;
  name: string;
  unit: string;
  step: number;
  issuer_name: string;
  base_url: string;
  host: string;
  intro: string;
  key_guide: string;
  no_recipient: string;
  arrival: string;
  not_allowed: string;
  insufficient: string;
  key_invalid: string;
  rate: number;
  endpoint_version: number;
  test_key_ciphertext: string | null;
  test_key_version: number;
  test_recipient_id: string | null;
  passed_test_id: string | null;
  passed_endpoint_version: number | null;
  last_test_started_at: number | null;
  submitted_at: number | null;
  reviewed_at: number | null;
  reviewed_by: string | null;
  review_note: string | null;
  online_at: number | null;
  paused_by: string | null;
  paused_at: number | null;
  retired_at: number | null;
  missed_in_row: number;
  breaker_until: number | null;
  version: number;
  created_at: number;
  updated_at: number;
};

export function pointsError(
  status: 400 | 403 | 404 | 409 | 429 | 503,
  code: string,
  message: string,
): never {
  throw new ActivityError(status, code, message);
}

/**
 * The endpoint base for this environment: public https everywhere; local
 * development may also point at http://127.0.0.1 (the demo issuer).
 */
export function endpointOf(env: ApiBindings, value: string) {
  const local = /^http:\/\/127\.0\.0\.1:(\d{2,5})(\/[\w./-]*)?$/.exec(
    value.trim(),
  );
  if (local && env.APP_ENV === "local") {
    const url = value.trim().replace(/\/+$/, "");
    return { ok: true as const, url, host: `127.0.0.1:${local[1]}` };
  }
  return normalizePointsBaseUrl(value);
}

/** The words of a system that its people see (§6 §9). */
export type PointsCopy = {
  intro: string;
  keyGuide: string;
  noRecipient: string;
  arrival: string;
  notAllowed: string;
  insufficient: string;
  keyInvalid: string;
};

export function publicOf(row: PointsSystemRow): PublicPointsSystem {
  return {
    id: row.id,
    name: row.name,
    unit: row.unit,
    step: row.step,
    issuerName: row.issuer_name,
    host: row.host,
    status: row.status,
  };
}

export function copyOf(row: PointsSystemRow): PointsCopy {
  return {
    intro: row.intro,
    keyGuide: row.key_guide,
    noRecipient: row.no_recipient,
    arrival: row.arrival,
    notAllowed: row.not_allowed,
    insufficient: row.insufficient,
    keyInvalid: row.key_invalid,
  };
}

/** Whether payouts may go now: online, not resting after misses (§5). */
export function deliverable(row: PointsSystemRow, now = Date.now()) {
  return (
    row.status === "online" &&
    (row.breaker_until === null || row.breaker_until <= now)
  );
}

export async function readPointsSettings(env: ApiBindings) {
  const row = await env.DB.prepare(
    "SELECT enabled,version,updated_at FROM points_settings WHERE id='global'",
  ).first<{ enabled: number; version: number; updated_at: number }>();
  return {
    enabled: row?.enabled === 1,
    version: row?.version ?? 1,
    updatedAt: row?.updated_at ?? 0,
  };
}

export async function updatePointsSettings(
  env: ApiBindings,
  adminId: string,
  input: { enabled: boolean; version: number },
) {
  const result = await env.DB.prepare(
    `UPDATE points_settings SET enabled=?1,version=version+1,updated_by=?2,updated_at=?3
      WHERE id='global' AND version=?4`,
  )
    .bind(input.enabled ? 1 : 0, adminId, Date.now(), input.version)
    .run();
  if (!result.meta.changes)
    pointsError(409, "POINTS_SETTINGS_CONFLICT", "设置已更新，请刷新后重试");
  return readPointsSettings(env);
}

export async function readSystem(env: ApiBindings, id: string) {
  return env.DB.prepare("SELECT * FROM points_systems WHERE id=?")
    .bind(id)
    .first<PointsSystemRow>();
}

export async function requireSystem(env: ApiBindings, id: string) {
  const row = await readSystem(env, id);
  if (!row) pointsError(404, "POINTS_NOT_FOUND", "没有这个积分");
  return row;
}

/** The owner's own system (the 站长 may read any). */
export async function requireOwnSystem(
  env: ApiBindings,
  userId: string,
  id: string,
) {
  const row = await requireSystem(env, id);
  if (row.owner_id !== userId)
    pointsError(404, "POINTS_NOT_FOUND", "没有这个积分");
  return row;
}

/** What the owner sees of a system: all of it but the test key. */
export function ownerView(row: PointsSystemRow) {
  return {
    ...publicOf(row),
    ...copyOf(row),
    baseUrl: row.base_url,
    rate: row.rate,
    endpointVersion: row.endpoint_version,
    hasTestKey: row.test_key_ciphertext !== null,
    testRecipientId: row.test_recipient_id,
    passed:
      row.passed_test_id !== null &&
      row.passed_endpoint_version === row.endpoint_version,
    passedTestId: row.passed_test_id,
    lastTestStartedAt: row.last_test_started_at,
    submittedAt: row.submitted_at,
    reviewedAt: row.reviewed_at,
    reviewNote: row.review_note,
    onlineAt: row.online_at,
    pausedBy: row.paused_by,
    pausedAt: row.paused_at,
    retiredAt: row.retired_at,
    breakerUntil: row.breaker_until,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
export type PointsOwnerView = ReturnType<typeof ownerView>;

export async function listOwnSystems(env: ApiBindings, userId: string) {
  const [rows, access] = await Promise.all([
    env.DB.prepare(
      "SELECT * FROM points_systems WHERE owner_id=? ORDER BY created_at DESC",
    )
      .bind(userId)
      .all<PointsSystemRow>(),
    transferAccess(env, userId),
  ]);
  const live = rows.results.filter((row) => row.status !== "retired").length;
  return {
    items: rows.results.map(ownerView),
    plus: access.allowed,
    canAdd: access.allowed && live < POINTS_LIMITS.systemsPerOwner,
    max: POINTS_LIMITS.systemsPerOwner,
  };
}

/** Online systems a sender may pick (§8). */
export async function listOnlineSystems(env: ApiBindings) {
  const rows = await env.DB.prepare(
    "SELECT * FROM points_systems WHERE status='online' ORDER BY online_at ASC",
  ).all<PointsSystemRow>();
  return rows.results.map((row) => ({ ...publicOf(row), ...copyOf(row) }));
}

async function nameTaken(
  env: ApiBindings,
  name: string,
  except: string | null,
) {
  const row = await env.DB.prepare(
    `SELECT 1 AS taken FROM points_systems WHERE lower(name)=lower(?1)
      AND status<>'retired' AND id IS NOT ?2`,
  )
    .bind(name, except)
    .first<{ taken: number }>();
  return row !== null;
}

function checkedEndpoint(env: ApiBindings, value: string) {
  const endpoint = endpointOf(env, value);
  if (!endpoint.ok) pointsError(400, "INVALID_POINTS", endpoint.message);
  return endpoint;
}

export async function createSystem(
  env: ApiBindings,
  userId: string,
  config: PointsSystemConfig,
) {
  const access = await transferAccess(env, userId);
  if (!access.allowed)
    pointsError(403, "POINTS_PLUS_ONLY", "开通🐟额 PLUS 才能添加积分");
  const endpoint = checkedEndpoint(env, config.baseUrl);
  if (await nameTaken(env, config.name, null))
    pointsError(409, "POINTS_NAME_TAKEN", "已经有同名的积分了");
  const id = crypto.randomUUID();
  const now = Date.now();
  const result = await env.DB.prepare(
    `INSERT INTO points_systems (id,owner_id,status,name,unit,step,issuer_name,base_url,host,
      intro,key_guide,no_recipient,arrival,not_allowed,insufficient,key_invalid,rate,
      created_at,updated_at)
     SELECT ?1,?2,'draft',?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?17
     WHERE (SELECT COUNT(*) FROM points_systems WHERE owner_id=?2 AND status<>'retired') < ?18`,
  )
    .bind(
      id,
      userId,
      config.name,
      config.unit,
      config.step,
      config.issuerName,
      endpoint.url,
      endpoint.host,
      config.intro,
      config.keyGuide,
      config.noRecipient,
      config.arrival,
      config.notAllowed,
      config.insufficient,
      config.keyInvalid,
      config.rate,
      now,
      POINTS_LIMITS.systemsPerOwner,
    )
    .run();
  if (!result.meta.changes)
    pointsError(
      409,
      "POINTS_TOO_MANY",
      `每人最多接入 ${POINTS_LIMITS.systemsPerOwner} 种三方积分`,
    );
  return ownerView(await requireSystem(env, id));
}

const COLUMN: Record<(typeof POINTS_COPY_FIELDS)[number], string> = {
  name: "name",
  unit: "unit",
  issuerName: "issuer_name",
  intro: "intro",
  keyGuide: "key_guide",
  noRecipient: "no_recipient",
  arrival: "arrival",
  notAllowed: "not_allowed",
  insufficient: "insufficient",
  keyInvalid: "key_invalid",
  rate: "rate",
};

/** Open 红包 of a system with something still to pay: a coarser step must wait. */
async function openHongbaoCount(env: ApiBindings, systemId: string) {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS count FROM activities WHERE points_system_id=?
      AND opened_at IS NOT NULL AND ended_at IS NULL AND deleted_at IS NULL`,
  )
    .bind(systemId)
    .first<{ count: number }>();
  return row?.count ?? 0;
}

export async function updateSystem(
  env: ApiBindings,
  userId: string,
  id: string,
  config: PointsSystemConfig,
  version: number,
) {
  const row = await requireOwnSystem(env, userId, id);
  if (row.status === "retired")
    pointsError(409, "POINTS_RETIRED", "这个积分已经下架了");
  if (row.version !== version)
    pointsError(409, "POINTS_VERSION_CONFLICT", "已经有新的修改，请刷新后重试");
  const endpoint = checkedEndpoint(env, config.baseUrl);
  const endpointChanged =
    endpoint.url !== row.base_url || config.step !== row.step;
  if (endpointChanged && row.status === "online")
    pointsError(
      409,
      "POINTS_ENDPOINT_ONLINE",
      "已上线时不能改接口地址或最小单位，先暂停",
    );
  // A finer unit divides the old one; a coarser one waits for no open 红包.
  if (
    config.step !== row.step &&
    row.step % config.step !== 0 &&
    (await openHongbaoCount(env, id)) > 0
  )
    pointsError(
      409,
      "POINTS_STEP_OPEN",
      "还有开放中的红包，最小单位只能改得更细（新单位要能整除旧单位）",
    );
  if (
    config.name.toLowerCase() !== row.name.toLowerCase() &&
    (await nameTaken(env, config.name, id))
  )
    pointsError(409, "POINTS_NAME_TAKEN", "已经有同名的积分了");
  const now = Date.now();
  const logged = row.submitted_at !== null;
  const changes = POINTS_COPY_FIELDS.flatMap((field) => {
    const column = COLUMN[field];
    const before = String((row as Record<string, unknown>)[column] ?? "");
    const after = String(config[field]);
    return before === after ? [] : [{ field, before, after }];
  });
  if (endpointChanged) {
    if (endpoint.url !== row.base_url)
      changes.push({
        field: "baseUrl" as never,
        before: row.base_url,
        after: endpoint.url,
      });
    if (config.step !== row.step)
      changes.push({
        field: "step" as never,
        before: String(row.step),
        after: String(config.step),
      });
  }
  const statements = [
    env.DB.prepare(
      `UPDATE points_systems SET name=?1,unit=?2,step=?3,issuer_name=?4,base_url=?5,host=?6,
        intro=?7,key_guide=?8,no_recipient=?9,arrival=?10,not_allowed=?11,insufficient=?12,
        key_invalid=?13,rate=?14,
        endpoint_version=endpoint_version+?15,
        status=CASE WHEN ?15=1 AND status IN ('reviewing','paused') THEN 'draft' ELSE status END,
        version=version+1,updated_at=?16
       WHERE id=?17 AND version=?18`,
    ).bind(
      config.name,
      config.unit,
      config.step,
      config.issuerName,
      endpoint.url,
      endpoint.host,
      config.intro,
      config.keyGuide,
      config.noRecipient,
      config.arrival,
      config.notAllowed,
      config.insufficient,
      config.keyInvalid,
      config.rate,
      endpointChanged ? 1 : 0,
      now,
      id,
      version,
    ),
    ...(logged
      ? changes.map((change) =>
          env.DB.prepare(
            `INSERT INTO points_copy_changes (id,system_id,actor_id,field,before,after,created_at)
             SELECT ?1,?2,?3,?4,?5,?6,?7 WHERE changes()=1`,
          ).bind(
            crypto.randomUUID(),
            id,
            userId,
            change.field,
            change.before,
            change.after,
            now,
          ),
        )
      : []),
  ];
  const results = await env.DB.batch(statements);
  if (!results[0]?.meta.changes)
    pointsError(409, "POINTS_VERSION_CONFLICT", "已经有新的修改，请刷新后重试");
  return ownerView(await requireSystem(env, id));
}

/** 提交审核 (§4): only with a self-test passed for this endpoint. */
export async function submitSystem(
  env: ApiBindings,
  userId: string,
  id: string,
) {
  const row = await requireOwnSystem(env, userId, id);
  if (row.status !== "draft")
    pointsError(409, "POINTS_NOT_DRAFT", "现在不能提交审核");
  if (
    row.passed_test_id === null ||
    row.passed_endpoint_version !== row.endpoint_version
  )
    pointsError(409, "POINTS_TEST_NEEDED", "先通过接口测试，再提交审核");
  const now = Date.now();
  await env.DB.prepare(
    `UPDATE points_systems SET status='reviewing',submitted_at=?1,review_note=NULL,
      version=version+1,updated_at=?1 WHERE id=?2 AND status='draft'`,
  )
    .bind(now, id)
    .run();
  return ownerView(await requireSystem(env, id));
}

/** End every open 红包 of a system, with why (§5 §7). */
export function endOpenStatements(
  env: ApiBindings,
  systemId: string,
  reason: "retired" | "key_removed",
  authorId?: string,
) {
  return env.DB.prepare(
    `UPDATE activities SET ended_at=?1,end_reason='points',points_stop_reason=?2,
      version=version+1,updated_at=?1
     WHERE points_system_id=?3 AND funding='points' AND opened_at IS NOT NULL
       AND ended_at IS NULL AND (?4 IS NULL OR author_id=?4)`,
  ).bind(Date.now(), reason, systemId, authorId ?? null);
}

/** 下架 by its owner or the 站长: its open 红包 end at once. */
export async function retireSystem(
  env: ApiBindings,
  actorId: string,
  id: string,
  admin: boolean,
) {
  const row = admin
    ? await requireSystem(env, id)
    : await requireOwnSystem(env, actorId, id);
  if (row.status === "retired") return ownerView(row);
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE points_systems SET status='retired',retired_at=?1,paused_by=?2,
        version=version+1,updated_at=?1 WHERE id=?3`,
    ).bind(now, admin ? "admin" : "owner", id),
    endOpenStatements(env, id, "retired"),
  ]);
  return ownerView(await requireSystem(env, id));
}

/** 暂停 (owner or 站长) and 恢复: claims are stopped before a share is taken. */
export async function pauseSystem(
  env: ApiBindings,
  actorId: string,
  id: string,
  admin: boolean,
) {
  const row = admin
    ? await requireSystem(env, id)
    : await requireOwnSystem(env, actorId, id);
  if (row.status !== "online")
    pointsError(409, "POINTS_NOT_ONLINE", "只有已上线的能暂停");
  const now = Date.now();
  await env.DB.prepare(
    `UPDATE points_systems SET status='paused',paused_by=?1,paused_at=?2,
      version=version+1,updated_at=?2 WHERE id=?3 AND status='online'`,
  )
    .bind(admin ? "admin" : "owner", now, id)
    .run();
  return ownerView(await requireSystem(env, id));
}

export async function resumeSystem(
  env: ApiBindings,
  actorId: string,
  id: string,
  admin: boolean,
) {
  const row = admin
    ? await requireSystem(env, id)
    : await requireOwnSystem(env, actorId, id);
  if (row.status !== "paused")
    pointsError(409, "POINTS_NOT_PAUSED", "现在没有暂停");
  // The owner cannot undo the 站长's pause.
  if (!admin && row.paused_by === "admin")
    pointsError(403, "POINTS_PAUSED_BY_ADMIN", "这是站长暂停的，要等站长恢复");
  // An endpoint changed since it was reviewed goes back through review.
  if (
    row.passed_endpoint_version !== row.endpoint_version ||
    row.reviewed_at === null
  )
    pointsError(409, "POINTS_REVIEW_NEEDED", "接口改过了，要重新测试和审核");
  const now = Date.now();
  await env.DB.prepare(
    `UPDATE points_systems SET status='online',paused_by=NULL,paused_at=NULL,
      missed_in_row=0,breaker_until=NULL,version=version+1,updated_at=?1
     WHERE id=?2 AND status='paused'`,
  )
    .bind(now, id)
    .run();
  return ownerView(await requireSystem(env, id));
}

/** The 站长's review (§7): online, or back to draft with a note. */
export async function reviewSystem(
  env: ApiBindings,
  adminId: string,
  id: string,
  decision: { approve: boolean; note: string },
) {
  const row = await requireSystem(env, id);
  if (row.status !== "reviewing")
    pointsError(409, "POINTS_NOT_REVIEWING", "现在不是待审核");
  const now = Date.now();
  await env.DB.prepare(
    decision.approve
      ? `UPDATE points_systems SET status='online',reviewed_at=?1,reviewed_by=?2,review_note=?3,
          online_at=COALESCE(online_at,?1),missed_in_row=0,breaker_until=NULL,
          version=version+1,updated_at=?1 WHERE id=?4 AND status='reviewing'`
      : `UPDATE points_systems SET status='draft',reviewed_at=?1,reviewed_by=?2,review_note=?3,
          version=version+1,updated_at=?1 WHERE id=?4 AND status='reviewing'`,
  )
    .bind(now, adminId, decision.note || null, id)
    .run();
  return ownerView(await requireSystem(env, id));
}
