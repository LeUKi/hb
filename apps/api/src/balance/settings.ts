// 站内🐟额 settings: one versioned row, written as the attempt intervals
// are (a version guard, the change, then the row by version, in one batch).
import type {
  BalanceSettings,
  BalanceSettingsInput,
  UpdateBalanceSettingsInput,
} from "@hb/contracts";
import { databaseNow } from "../activities/lifecycle";
import type { ApiBindings } from "../env";
import { balanceError } from "./errors";

type SettingsRow = {
  version: number;
  topup_enabled: number;
  withdraw_enabled: number;
  topup_fee_percent: number;
  withdraw_fee_percent: number;
  withdraw_max_minor: number;
  allowlist_enabled: number;
  allowlist: string;
  updated_at: number;
};

const SELECT_SETTINGS = `SELECT version,topup_enabled,withdraw_enabled,topup_fee_percent,
  withdraw_fee_percent,withdraw_max_minor,allowlist_enabled,allowlist,updated_at
  FROM balance_settings WHERE id='global'`;

function settingsOf(row: SettingsRow): BalanceSettings {
  return {
    version: row.version,
    topupEnabled: row.topup_enabled === 1,
    withdrawEnabled: row.withdraw_enabled === 1,
    topupFeePercent: row.topup_fee_percent,
    withdrawFeePercent: row.withdraw_fee_percent,
    withdrawMaxMinor: row.withdraw_max_minor,
    allowlistEnabled: row.allowlist_enabled === 1,
    allowlist: JSON.parse(row.allowlist) as string[],
    updatedAt: row.updated_at,
  };
}

export async function readBalanceSettings(env: ApiBindings) {
  const row = await env.DB.prepare(SELECT_SETTINGS).first<SettingsRow>();
  if (!row) throw new Error("Missing balance settings");
  return settingsOf(row);
}

/**
 * Whether someone may use 🐟额: everyone once the allowlist is off; until
 * then, the community IDs on it. The entry is hidden from everyone else.
 */
export async function balanceOpenFor(env: ApiBindings, userId: string) {
  const row = await env.DB.prepare(
    `SELECT CASE WHEN s.allowlist_enabled=0 THEN 1
      WHEN u.provider='linux_do' AND EXISTS(SELECT 1 FROM json_each(s.allowlist) WHERE value=u.external_id) THEN 1
      ELSE 0 END AS open
    FROM balance_settings s JOIN users u ON u.id=? AND u.active=1 WHERE s.id='global'`,
  )
    .bind(userId)
    .first<{ open: number }>();
  return row?.open === 1;
}

export async function requireBalanceOpen(env: ApiBindings, userId: string) {
  if (!(await balanceOpenFor(env, userId)))
    balanceError(404, "BALANCE_NOT_OPEN", "站内🐟额暂未开放");
}

function snapshot(settings: BalanceSettingsInput) {
  return JSON.stringify({
    topupEnabled: settings.topupEnabled,
    withdrawEnabled: settings.withdrawEnabled,
    topupFeePercent: settings.topupFeePercent,
    withdrawFeePercent: settings.withdrawFeePercent,
    withdrawMaxMinor: settings.withdrawMaxMinor,
    allowlistEnabled: settings.allowlistEnabled,
    allowlist: settings.allowlist,
  });
}

export async function updateBalanceSettings(
  env: ApiBindings,
  actorUserId: string,
  input: UpdateBalanceSettingsInput,
) {
  const { expectedVersion, ...next } = input;
  const allowlist = [...new Set(next.allowlist)];
  const previous = await readBalanceSettings(env);
  try {
    await env.DB.batch([
      env.DB.prepare(`SELECT json(CASE WHEN EXISTS(
        SELECT 1 FROM balance_settings WHERE id='global' AND version=?
      ) THEN '{}' ELSE '' END)`).bind(expectedVersion),
      env.DB.prepare(`INSERT INTO balance_setting_changes
        (id,actor_user_id,previous_version,next_version,previous,next,created_at)
        SELECT ?,?,version,version+1,?,?,${databaseNow}
        FROM balance_settings WHERE id='global' AND version=?`).bind(
        crypto.randomUUID(),
        actorUserId,
        snapshot(previous),
        snapshot({ ...next, allowlist }),
        expectedVersion,
      ),
      env.DB.prepare(`UPDATE balance_settings SET version=version+1,
        topup_enabled=?,withdraw_enabled=?,topup_fee_percent=?,withdraw_fee_percent=?,
        withdraw_max_minor=?,allowlist_enabled=?,allowlist=?,
        updated_at=${databaseNow},updated_by_user_id=?
        WHERE id='global' AND version=?`).bind(
        Number(next.topupEnabled),
        Number(next.withdrawEnabled),
        next.topupFeePercent,
        next.withdrawFeePercent,
        next.withdrawMaxMinor,
        Number(next.allowlistEnabled),
        JSON.stringify(allowlist),
        actorUserId,
        expectedVersion,
      ),
    ]);
  } catch (error) {
    if ((await readBalanceSettings(env)).version !== expectedVersion)
      balanceError(
        409,
        "BALANCE_SETTINGS_CONFLICT",
        "🐟额设置已经变了，请刷新后再试。当前输入已保留。",
      );
    throw error;
  }
  return readBalanceSettings(env);
}

export type BalanceSettingChange = {
  id: string;
  actorUserId: string;
  actorDisplayName: string;
  previousVersion: number;
  nextVersion: number;
  previous: BalanceSettingsInput;
  next: BalanceSettingsInput;
  createdAt: number;
};

export async function recentBalanceSettingChanges(
  env: ApiBindings,
): Promise<BalanceSettingChange[]> {
  const rows = await env.DB.prepare(
    `SELECT c.id,c.actor_user_id AS actorUserId,COALESCE(u.display_name,c.actor_user_id) AS actorDisplayName,
      c.previous_version AS previousVersion,c.next_version AS nextVersion,c.previous,c.next,c.created_at AS createdAt
    FROM balance_setting_changes c LEFT JOIN users u ON u.id=c.actor_user_id
    ORDER BY c.created_at DESC,c.id DESC LIMIT 20`,
  ).all<
    Omit<BalanceSettingChange, "previous" | "next"> & {
      previous: string;
      next: string;
    }
  >();
  return rows.results.map((row) => ({
    ...row,
    previous: JSON.parse(row.previous) as BalanceSettingsInput,
    next: JSON.parse(row.next) as BalanceSettingsInput,
  }));
}
