import type {
  CreateMerchantInput,
  Merchant,
  MerchantList,
  RepairPaymentCredentialInput,
  UpdateMerchantInput,
} from "@hb/contracts";
import { and, desc, eq, lt, or } from "drizzle-orm";
import { ActivityError, activityNotFound } from "../activities/errors";
import { createDb } from "../db/client";
import { merchants, simulationControls } from "../db/schema";
import type { ApiBindings } from "../env";
import {
  allowsRealSending,
  isLocalSimulation,
  readPlatformControls,
} from "../runtime/controls";
import { digestPassword, encryptString } from "../security/crypto";
import {
  hasMerchantImpact,
  MerchantChangeConfirmationError,
  merchantImpactSql,
  readMerchantImpact,
} from "./configuration";
import { publicationEligibility } from "./publication";
import {
  credentialVerificationView,
  recoverCredentialChecks,
} from "./verification";

function merchantConflict(
  message = "商户配置已更新。当前输入已保留，请先刷新商户配置后重试。",
): never {
  throw new ActivityError(409, "MERCHANT_CONFLICT", message);
}

function merchantCreateDigestInput(input: CreateMerchantInput) {
  const mode = input.mode ?? "simulation";
  const base = {
    requestId: input.requestId,
    label: input.label,
    clientId: input.clientId,
    secret: input.secret,
  };
  return mode === "simulation" ? base : { ...base, mode };
}

export async function ownedMerchant(
  env: ApiBindings,
  id: string,
  authorId: string,
) {
  const row = await createDb(env.DB)
    .select()
    .from(merchants)
    .where(eq(merchants.id, id))
    .get();
  if (!row || row.authorId !== authorId) activityNotFound();
  return row;
}

export async function merchantView(
  env: ApiBindings,
  row: typeof merchants.$inferSelect,
): Promise<Merchant> {
  await recoverCredentialChecks(env);
  const verification = await credentialVerificationView(
    env,
    row.id,
    row.credentialVersion,
  );
  const eligibility = await publicationEligibility(env, row, verification);
  const base = {
    credentialVerification: verification,
    usageStatus: row.usageStatus,
    publicationEligibility: eligibility,
    id: row.id,
    label: row.label,
    clientId: row.clientId,
    version: row.version,
    credentialVersion: row.credentialVersion,
    pausedReason: row.pausedReason,
    createdAt: new Date(row.createdAt).toISOString(),
    updatedAt: new Date(row.updatedAt).toISOString(),
  };
  if (row.mode === "real")
    return {
      ...base,
      mode: "real",
      capabilities: {
        canExecutePayments:
          allowsRealSending(env, await readPlatformControls(env)) &&
          verification.status === "passed",
        canSimulate: false,
      },
    };
  const control = await createDb(env.DB)
    .select()
    .from(simulationControls)
    .where(eq(simulationControls.merchantId, row.id))
    .get();
  return {
    ...base,
    mode: "simulation",
    capabilities: {
      canExecutePayments: isLocalSimulation(env),
      canSimulate: isLocalSimulation(env),
    },
    scenario: control?.scenario ?? "normal",
  };
}

export async function getMerchant(
  env: ApiBindings,
  id: string,
  authorId: string,
) {
  return merchantView(env, await ownedMerchant(env, id, authorId));
}

export function decodeTimeCursor(
  cursor?: string,
): { time: number; id: string } | undefined {
  if (!cursor) return undefined;
  try {
    const value = JSON.parse(atob(cursor));
    if (
      !Number.isSafeInteger(value.time) ||
      typeof value.id !== "string" ||
      !/^[a-f0-9-]{36}$/i.test(value.id)
    )
      throw new Error();
    return { time: value.time, id: value.id };
  } catch {
    throw new ActivityError(400, "INVALID_CURSOR", "分页标识无效");
  }
}
export function encodeTimeCursor(row: { createdAt: number; id: string }) {
  return btoa(JSON.stringify({ time: row.createdAt, id: row.id }));
}

export async function listMerchants(
  env: ApiBindings,
  authorId: string,
  cursor?: string,
): Promise<MerchantList> {
  const before = decodeTimeCursor(cursor);
  const rows = await createDb(env.DB)
    .select()
    .from(merchants)
    .where(
      and(
        eq(merchants.authorId, authorId),
        before
          ? or(
              lt(merchants.createdAt, before.time),
              and(
                eq(merchants.createdAt, before.time),
                lt(merchants.id, before.id),
              ),
            )
          : undefined,
      ),
    )
    .orderBy(desc(merchants.createdAt), desc(merchants.id))
    .limit(21);
  const items = rows.slice(0, 20);
  const last = items.at(-1);
  const current = await dbCurrentMerchant(env, authorId);
  return {
    currentMerchantId: current?.id ?? null,
    canCreate: !current,
    canSimulate: isLocalSimulation(env),
    items: await Promise.all(items.map((row) => merchantView(env, row))),
    nextCursor: rows.length > 20 && last ? encodeTimeCursor(last) : null,
  };
}

export async function dbCurrentMerchant(env: ApiBindings, authorId: string) {
  return createDb(env.DB)
    .select()
    .from(merchants)
    .where(
      and(
        eq(merchants.authorId, authorId),
        eq(merchants.usageStatus, "current"),
      ),
    )
    .get();
}

function currentMerchantExists(): never {
  throw new ActivityError(
    409,
    "MERCHANT_ALREADY_EXISTS",
    "每个账号只能配置一个当前商户，请在已有商户中维护密钥。",
  );
}

export async function createMerchant(
  env: ApiBindings,
  authorId: string,
  input: CreateMerchantInput,
) {
  const mode = input.mode ?? "simulation";
  const db = createDb(env.DB);
  const fingerprint = await digestPassword(
    `merchant-create:${JSON.stringify(merchantCreateDigestInput(input))}`,
    env.PASSWORD_DIGEST_KEY,
  );
  const previous = () =>
    db
      .select()
      .from(merchants)
      .where(
        and(
          eq(merchants.authorId, authorId),
          eq(merchants.requestId, input.requestId),
        ),
      )
      .get();
  const checkPrevious = async () => {
    const old = await previous();
    if (!old) return null;
    if (old.requestDigest !== fingerprint)
      merchantConflict("同一创建请求不能更换商户配置");
    return merchantView(env, old);
  };
  const old = await checkPrevious();
  if (old) return old;
  if (mode === "simulation" && !isLocalSimulation(env))
    throw new ActivityError(
      400,
      "SIMULATION_NOT_AVAILABLE",
      "此环境不提供模拟商户。",
    );
  if (await dbCurrentMerchant(env, authorId)) currentMerchantExists();
  const id = crypto.randomUUID();
  const now = Date.now();
  const ciphertext = await encryptString(
    input.secret,
    env,
    `merchant:${id}:credential:1`,
  );
  try {
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO merchants (id,author_id,request_id,request_digest,client_id,label,mode,created_at,updated_at) VALUES (?,CASE WHEN EXISTS(SELECT 1 FROM users WHERE id=? AND active=1) THEN ? ELSE NULL END,?,?,?,?,?,?,?)`,
      ).bind(
        id,
        authorId,
        authorId,
        input.requestId,
        fingerprint,
        input.clientId,
        input.label,
        mode,
        now,
        now,
      ),
      env.DB.prepare(
        `INSERT INTO merchant_credentials (id,merchant_id,version,ciphertext,client_id,created_at) VALUES (?,?,1,?,?,?)`,
      ).bind(crypto.randomUUID(), id, ciphertext, input.clientId, now),
      ...(mode === "simulation"
        ? [
            env.DB.prepare(
              `INSERT INTO simulation_controls (merchant_id,scenario,updated_at) VALUES (?,'normal',?)`,
            ).bind(id, now),
          ]
        : []),
    ]);
  } catch (error) {
    const winner = await checkPrevious();
    if (winner) return winner;
    if (await dbCurrentMerchant(env, authorId)) currentMerchantExists();
    if (
      await env.DB.prepare(
        "SELECT merchant_id FROM merchant_client_ids WHERE client_id=?",
      )
        .bind(input.clientId)
        .first()
    )
      merchantConflict("此商户应用已配置，请使用原配置维护");
    throw error;
  }
  return getMerchant(env, id, authorId);
}

async function previousChange(
  env: ApiBindings,
  id: string,
  requestId: string,
  digest: string,
) {
  const previous = await env.DB.prepare(
    "SELECT request_digest,result_version,credential_version,client_id FROM merchant_config_changes WHERE merchant_id=? AND request_id=?",
  )
    .bind(id, requestId)
    .first<{
      request_digest: string;
      result_version: number;
      credential_version: number;
      client_id: string;
    }>();
  if (previous && previous.request_digest !== digest)
    merchantConflict("同一保存请求不能更换配置内容");
  return previous;
}

export async function updateMerchant(
  env: ApiBindings,
  id: string,
  authorId: string,
  input: UpdateMerchantInput,
) {
  const row = await ownedMerchant(env, id, authorId);
  const digest = await digestPassword(
    `merchant-update:${JSON.stringify({ version: input.version, label: input.label, clientId: input.clientId ?? null, secret: input.secret ?? null })}`,
    env.PASSWORD_DIGEST_KEY,
  );
  const requestId = input.requestId ?? `legacy:${input.version}:${digest}`;
  const result = async () => {
    const change = await previousChange(env, id, requestId, digest);
    if (!change) throw new Error("Configuration result missing");
    return {
      ...(await getMerchant(env, id, authorId)),
      appliedChange: {
        requestId,
        resultVersion: change.result_version,
        clientId: change.client_id,
        credentialVersion: change.credential_version,
      },
    };
  };
  if (await previousChange(env, id, requestId, digest)) return result();
  if (row.version !== input.version) merchantConflict();
  const clientId = input.clientId ?? row.clientId;
  if (clientId !== row.clientId && !input.secret)
    throw new ActivityError(
      400,
      "MERCHANT_SECRET_REQUIRED",
      "更换 Client ID 时必须填写对应密钥。",
    );
  const credentialsChanged =
    input.secret !== undefined || clientId !== row.clientId;
  const impact = credentialsChanged ? await readMerchantImpact(env, row) : null;
  if (
    impact &&
    hasMerchantImpact(impact.impact) &&
    input.confirmationToken !== impact.confirmationToken
  )
    throw new MerchantChangeConfirmationError(impact);
  const registration = await env.DB.prepare(
    "SELECT merchant_id FROM merchant_client_ids WHERE client_id=?",
  )
    .bind(clientId)
    .first<{ merchant_id: string }>();
  if (registration && registration.merchant_id !== id)
    merchantConflict("此 Client ID 已属于其他商户配置。");
  const now = Date.now();
  const nextCredential =
    input.secret === undefined
      ? row.credentialVersion
      : await nextCredentialVersion(env, id);
  const statements: D1PreparedStatement[] = [];
  if (!registration)
    statements.push(
      env.DB.prepare(
        "INSERT INTO merchant_client_ids(client_id,merchant_id,created_at) VALUES(?,?,?)",
      ).bind(clientId, id, now),
    );
  statements.push(
    env.DB.prepare(
      `UPDATE merchants SET version=CASE WHEN version=? AND author_id=? AND EXISTS(SELECT 1 FROM users WHERE id=merchants.author_id AND active=1) ${impact ? `AND (${merchantImpactSql})=?` : ""} THEN version+1 ELSE NULL END,label=?,client_id=?,credential_version=?,updated_at=? WHERE id=?`,
    ).bind(
      input.version,
      authorId,
      ...(impact ? [id, id, impact.snapshot] : []),
      input.label,
      clientId,
      nextCredential,
      now,
      id,
    ),
  );
  if (input.secret !== undefined)
    statements.push(
      env.DB.prepare(
        "INSERT INTO merchant_credentials(id,merchant_id,version,ciphertext,client_id,created_at) VALUES(?,?,?,?,?,?)",
      ).bind(
        crypto.randomUUID(),
        id,
        nextCredential,
        await encryptString(
          input.secret,
          env,
          `merchant:${id}:credential:${nextCredential}`,
        ),
        clientId,
        now,
      ),
    );
  statements.push(
    env.DB.prepare(
      "INSERT INTO merchant_config_changes(id,merchant_id,request_id,request_digest,result_version,credential_version,client_id,purpose,created_at) VALUES(?,?,?,?,?,?,?,'current',?)",
    ).bind(
      crypto.randomUUID(),
      id,
      requestId,
      digest,
      input.version + 1,
      nextCredential,
      clientId,
      now,
    ),
  );
  try {
    await env.DB.batch(statements);
  } catch (error) {
    if (await previousChange(env, id, requestId, digest)) return result();
    const latest = await ownedMerchant(env, id, authorId);
    if (latest.version !== input.version) merchantConflict();
    const owner = await env.DB.prepare(
      "SELECT merchant_id FROM merchant_client_ids WHERE client_id=?",
    )
      .bind(clientId)
      .first<{ merchant_id: string }>();
    if (owner && owner.merchant_id !== id)
      merchantConflict("此 Client ID 已属于其他商户配置。");
    if (impact) {
      const changed = await readMerchantImpact(env, latest);
      if (changed.snapshot !== impact.snapshot)
        throw new MerchantChangeConfirmationError(changed);
    }
    throw error;
  }
  if (input.secret !== undefined && row.mode === "simulation")
    await env.DB.prepare(
      "UPDATE payment_tasks SET next_run_at=? WHERE merchant_id=? AND status IN ('waiting','reconciling')",
    )
      .bind(now, id)
      .run();
  return result();
}

/** Repair a bound application key without changing the merchant's current application. */
export async function repairPaymentCredential(
  env: ApiBindings,
  id: string,
  authorId: string,
  taskId: string,
  input: RepairPaymentCredentialInput,
) {
  const merchant = await ownedMerchant(env, id, authorId);
  const task = await env.DB.prepare(
    `SELECT p.status,p.mode,COALESCE((SELECT corrected_client_id FROM payment_identity_corrections WHERE task_id=p.id ORDER BY version DESC LIMIT 1),p.client_id) AS client_id FROM payment_tasks p WHERE p.id=? AND p.merchant_id=?`,
  )
    .bind(taskId, id)
    .first<{ status: string; mode: string; client_id: string }>();
  if (!task) activityNotFound();
  const digest = await digestPassword(
    `merchant-repair:${JSON.stringify({ taskId, version: input.version, secret: input.secret })}`,
    env.PASSWORD_DIGEST_KEY,
  );
  const old = await previousChange(env, id, input.requestId, digest);
  if (old)
    return {
      credentialVersion: old.credential_version,
      merchant: await getMerchant(env, id, authorId),
    };
  if (merchant.version !== input.version) merchantConflict();
  const repairable = await env.DB.prepare(
    "SELECT verification_status,verification_reason FROM merchant_credentials WHERE merchant_id=? AND client_id=? ORDER BY version DESC LIMIT 1",
  )
    .bind(id, task.client_id)
    .first<{
      verification_status: string;
      verification_reason: string | null;
    }>();
  if (
    task.mode !== "real" ||
    task.status === "confirmed" ||
    task.client_id === merchant.clientId ||
    repairable?.verification_status !== "rejected" ||
    repairable.verification_reason !== "credentials"
  )
    throw new ActivityError(
      400,
      "PAYMENT_CREDENTIAL_REPAIR_NOT_ALLOWED",
      "此付款无需修复核对凭证。",
    );
  const next = await nextCredentialVersion(env, id);
  const now = Date.now();
  try {
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE merchants SET version=CASE WHEN version=? AND client_id!=? AND EXISTS(SELECT 1 FROM users WHERE id=merchants.author_id AND active=1) AND EXISTS(SELECT 1 FROM merchant_credentials c WHERE c.merchant_id=merchants.id AND c.client_id=? AND c.verification_status='rejected' AND c.verification_reason='credentials' AND c.version=(SELECT MAX(version) FROM merchant_credentials WHERE merchant_id=c.merchant_id AND client_id=c.client_id)) AND EXISTS(SELECT 1 FROM payment_tasks p WHERE p.id=? AND p.merchant_id=merchants.id AND p.status!='confirmed' AND COALESCE((SELECT corrected_client_id FROM payment_identity_corrections WHERE task_id=p.id ORDER BY version DESC LIMIT 1),p.client_id)=?) THEN version+1 ELSE NULL END,updated_at=? WHERE id=?`,
      ).bind(
        input.version,
        task.client_id,
        task.client_id,
        taskId,
        task.client_id,
        now,
        id,
      ),
      env.DB.prepare(
        "INSERT INTO merchant_credentials(id,merchant_id,version,ciphertext,client_id,created_at) VALUES(?,?,?,?,?,?)",
      ).bind(
        crypto.randomUUID(),
        id,
        next,
        await encryptString(
          input.secret,
          env,
          `merchant:${id}:credential:${next}`,
        ),
        task.client_id,
        now,
      ),
      env.DB.prepare(
        "INSERT INTO merchant_config_changes(id,merchant_id,request_id,request_digest,result_version,credential_version,client_id,purpose,task_id,created_at) VALUES(?,?,?,?,?,?,?,'repair',?,?)",
      ).bind(
        crypto.randomUUID(),
        id,
        input.requestId,
        digest,
        input.version + 1,
        next,
        task.client_id,
        taskId,
        now,
      ),
    ]);
  } catch {
    const previous = await previousChange(env, id, input.requestId, digest);
    if (previous)
      return {
        credentialVersion: previous.credential_version,
        merchant: await getMerchant(env, id, authorId),
      };
    merchantConflict("付款或商户配置已更新，请刷新后重试。");
  }
  return {
    credentialVersion: next,
    merchant: await getMerchant(env, id, authorId),
  };
}

async function nextCredentialVersion(env: ApiBindings, id: string) {
  const row = await env.DB.prepare(
    "SELECT COALESCE(MAX(version),0)+1 AS version FROM merchant_credentials WHERE merchant_id=?",
  )
    .bind(id)
    .first<{ version: number }>();
  if (!row || !Number.isSafeInteger(row.version))
    throw new Error("Credential version unavailable");
  return row.version;
}
