// The 🐟额 platform app (docs/balance-design.md §2): a Credit 集市应用 that
// takes 转入 and, later, sends 转出. It is a merchant row of its own kind,
// so credentials, their checks and the Client ID registry are the ones every
// merchant uses; it belongs to no author's merchant list.
import type { PlatformApp, SavePlatformAppInput } from "@hb/contracts";
import type { ApiBindings } from "../env";
import { credentialVerificationView } from "../payments/verification";
import { digestPassword, encryptString } from "../security/crypto";
import { balanceError } from "./errors";

export type PlatformAppRow = {
  id: string;
  author_id: string;
  label: string;
  client_id: string;
  version: number;
  credential_version: number;
  request_id: string;
  request_digest: string;
  updated_at: number;
};

const SELECT_CURRENT = `SELECT id,author_id,label,client_id,version,credential_version,request_id,request_digest,updated_at
  FROM merchants WHERE kind='platform' AND usage_status='current'`;

export function readPlatformAppRow(env: ApiBindings) {
  return env.DB.prepare(SELECT_CURRENT).first<PlatformAppRow>();
}

export async function platformAppView(
  env: ApiBindings,
  row: PlatformAppRow,
): Promise<PlatformApp> {
  return {
    id: row.id,
    label: row.label,
    clientId: row.client_id,
    version: row.version,
    credentialVersion: row.credential_version,
    credentialVerification: await credentialVerificationView(
      env,
      row.id,
      row.credential_version,
    ),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

export async function readPlatformApp(env: ApiBindings) {
  const row = await readPlatformAppRow(env);
  return row ? platformAppView(env, row) : null;
}

function conflict(message: string): never {
  balanceError(409, "PLATFORM_APP_CONFLICT", message);
}

async function assertClientIdFree(
  env: ApiBindings,
  clientId: string,
  merchantId: string | null,
) {
  const owner = await env.DB.prepare(
    "SELECT merchant_id FROM merchant_client_ids WHERE client_id=?",
  )
    .bind(clientId)
    .first<{ merchant_id: string }>();
  if (owner && owner.merchant_id !== merchantId)
    conflict(
      "这个 Client ID 已经属于别的商户配置，平台应用要用新建的集市应用。",
    );
  return Boolean(owner);
}

/**
 * Creates the platform app, or changes its name, Client ID or key. A new
 * key is a new credential version; 转入 already made keep the version they
 * were made with, so they are checked with it.
 */
export async function savePlatformApp(
  env: ApiBindings,
  adminUserId: string,
  input: SavePlatformAppInput,
) {
  const digest = await digestPassword(
    `platform-app:${JSON.stringify({ version: input.version ?? null, label: input.label, clientId: input.clientId, secret: input.secret ?? null })}`,
    env.PASSWORD_DIGEST_KEY,
  );
  const current = await readPlatformAppRow(env);
  const now = Date.now();
  if (!current) {
    if (input.version !== undefined)
      conflict("平台应用已经变了，请刷新后再试。");
    if (!input.secret)
      balanceError(400, "PLATFORM_APP_SECRET_REQUIRED", "新建平台应用要填密钥");
    await assertClientIdFree(env, input.clientId, null);
    const id = crypto.randomUUID();
    try {
      await env.DB.batch([
        env.DB.prepare(
          `INSERT INTO merchants (id,author_id,request_id,request_digest,client_id,label,mode,kind,created_at,updated_at)
          VALUES (?,?,?,?,?,?,'real','platform',?,?)`,
        ).bind(
          id,
          adminUserId,
          input.requestId,
          digest,
          input.clientId,
          input.label,
          now,
          now,
        ),
        // The Client ID registers itself (merchants_register_client).
        env.DB.prepare(
          "INSERT INTO merchant_credentials (id,merchant_id,version,ciphertext,client_id,created_at) VALUES (?,?,1,?,?,?)",
        ).bind(
          crypto.randomUUID(),
          id,
          await encryptString(input.secret, env, `merchant:${id}:credential:1`),
          input.clientId,
          now,
        ),
      ]);
    } catch (error) {
      const winner = await readPlatformAppRow(env);
      if (
        winner?.request_id === input.requestId &&
        winner.request_digest === digest
      )
        return winner;
      if (winner) conflict("平台应用已经有人建好了，请刷新后再试。");
      throw error;
    }
    const created = await readPlatformAppRow(env);
    if (!created) throw new Error("Platform app missing after creation");
    return created;
  }

  // The same save sent again: its result, not a second change.
  const previous = await env.DB.prepare(
    "SELECT request_digest FROM merchant_config_changes WHERE merchant_id=? AND request_id=?",
  )
    .bind(current.id, input.requestId)
    .first<{ request_digest: string }>();
  if (previous) {
    if (previous.request_digest !== digest)
      conflict("同一次保存不能换内容，请刷新后再试。");
    return current;
  }
  if (current.request_id === input.requestId) {
    if (current.request_digest !== digest)
      conflict("同一次保存不能换内容，请刷新后再试。");
    return current;
  }
  if (input.version !== current.version)
    conflict("平台应用已经变了，请刷新后再试。当前输入已保留。");
  const clientChanged = input.clientId !== current.client_id;
  if (clientChanged && !input.secret)
    balanceError(
      400,
      "PLATFORM_APP_SECRET_REQUIRED",
      "换 Client ID 时要同时填这个应用的密钥",
    );
  // A 转出 is sent under the Client ID it was asked under (no corrections
  // for the platform app): a new one waits until none is 发放中.
  const sending = async () =>
    (
      await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM balance_withdrawals WHERE merchant_id=? AND status='sending'",
      )
        .bind(current.id)
        .first<{ count: number }>()
    )?.count ?? 0;
  const busy = () =>
    balanceError(
      409,
      "PLATFORM_APP_BUSY",
      "还有转出没发完，发完再换 Client ID。当前输入已保留。",
    );
  if (clientChanged && (await sending()) > 0) busy();
  const registered = await assertClientIdFree(env, input.clientId, current.id);
  const credentialVersion =
    input.secret === undefined
      ? current.credential_version
      : ((
          await env.DB.prepare(
            "SELECT MAX(version) AS version FROM merchant_credentials WHERE merchant_id=?",
          )
            .bind(current.id)
            .first<{ version: number }>()
        )?.version ?? 0) + 1;
  const statements: D1PreparedStatement[] = [];
  if (!registered)
    statements.push(
      env.DB.prepare(
        "INSERT INTO merchant_client_ids(client_id,merchant_id,created_at) VALUES(?,?,?)",
      ).bind(input.clientId, current.id, now),
    );
  statements.push(
    env.DB.prepare(
      `UPDATE merchants SET version=CASE WHEN version=? AND kind='platform'
          AND (?=0 OR NOT EXISTS(SELECT 1 FROM balance_withdrawals w WHERE w.merchant_id=merchants.id AND w.status='sending'))
        THEN version+1 ELSE NULL END,
        label=?,client_id=?,credential_version=?,updated_at=? WHERE id=?`,
    ).bind(
      input.version,
      clientChanged ? 1 : 0,
      input.label,
      input.clientId,
      credentialVersion,
      now,
      current.id,
    ),
  );
  if (input.secret !== undefined)
    statements.push(
      env.DB.prepare(
        "INSERT INTO merchant_credentials(id,merchant_id,version,ciphertext,client_id,created_at) VALUES(?,?,?,?,?,?)",
      ).bind(
        crypto.randomUUID(),
        current.id,
        credentialVersion,
        await encryptString(
          input.secret,
          env,
          `merchant:${current.id}:credential:${credentialVersion}`,
        ),
        input.clientId,
        now,
      ),
    );
  statements.push(
    env.DB.prepare(
      "INSERT INTO merchant_config_changes(id,merchant_id,request_id,request_digest,result_version,credential_version,client_id,purpose,created_at) VALUES(?,?,?,?,?,?,?,'current',?)",
    ).bind(
      crypto.randomUUID(),
      current.id,
      input.requestId,
      digest,
      input.version + 1,
      credentialVersion,
      input.clientId,
      now,
    ),
  );
  try {
    await env.DB.batch(statements);
  } catch (error) {
    const latest = await readPlatformAppRow(env);
    if (latest && latest.version !== input.version)
      conflict("平台应用已经变了，请刷新后再试。当前输入已保留。");
    if (clientChanged && (await sending()) > 0) busy();
    throw error;
  }
  const saved = await readPlatformAppRow(env);
  if (!saved) throw new Error("Platform app missing after update");
  return saved;
}
