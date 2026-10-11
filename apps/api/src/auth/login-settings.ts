import type { ApiBindings } from "../env";

export class LiteAuthLoginDisabledError extends Error {
  constructor() {
    super("LiteAUTH login is disabled");
    this.name = "LiteAuthLoginDisabledError";
  }
}

async function readLoginSettings(env: ApiBindings) {
  const row = await env.DB.prepare(
    "SELECT version,liteauth_enabled AS liteauthEnabled FROM login_settings WHERE id='global'",
  ).first<{ version: number; liteauthEnabled: number }>();
  if (
    !row ||
    !Number.isSafeInteger(row.version) ||
    row.version < 1 ||
    (row.liteauthEnabled !== 0 && row.liteauthEnabled !== 1)
  )
    throw new Error("Login settings are unavailable");
  return row;
}

export async function readLoginOptions(env: ApiBindings) {
  try {
    const row = await readLoginSettings(env);
    return { liteauthEnabled: row.liteauthEnabled === 1 };
  } catch {
    return { liteauthEnabled: false };
  }
}

/** Each callback keeps the version read before consuming its one-time state. */
export async function requireLiteAuthLogin(
  env: ApiBindings,
  expectedVersion?: number,
) {
  try {
    const row = await readLoginSettings(env);
    if (
      row.liteauthEnabled === 1 &&
      (expectedVersion === undefined || row.version === expectedVersion)
    )
      return row.version;
  } catch {
    // Configuration failures block new LiteAUTH logins without invalidating sessions.
  }
  throw new LiteAuthLoginDisabledError();
}

/** A failed guard aborts the D1 batch before state/session writes can commit. */
export function liteAuthLoginGuard(env: ApiBindings, version: number) {
  return env.DB.prepare(
    `SELECT json(CASE WHEN EXISTS (
      SELECT 1 FROM login_settings WHERE id='global' AND liteauth_enabled=1 AND version=?
    ) THEN '{}' ELSE '' END) AS liteauth_login_guard`,
  ).bind(version);
}
