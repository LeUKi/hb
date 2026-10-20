// 🐟额 settings: one versioned row, written as the attempt intervals
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
  hongbao_enabled: number;
  transfer_enabled: number;
  updated_at: number;
};

const SELECT_SETTINGS = `SELECT version,topup_enabled,withdraw_enabled,topup_fee_percent,
  withdraw_fee_percent,withdraw_max_minor,hongbao_enabled,transfer_enabled,updated_at
  FROM balance_settings WHERE id='global'`;

function settingsOf(row: SettingsRow): BalanceSettings {
  return {
    version: row.version,
    topupEnabled: row.topup_enabled === 1,
    withdrawEnabled: row.withdraw_enabled === 1,
    topupFeePercent: row.topup_fee_percent,
    withdrawFeePercent: row.withdraw_fee_percent,
    withdrawMaxMinor: row.withdraw_max_minor,
    hongbaoEnabled: row.hongbao_enabled === 1,
    transferEnabled: row.transfer_enabled === 1,
    updatedAt: row.updated_at,
  };
}

export async function readBalanceSettings(env: ApiBindings) {
  const row = await env.DB.prepare(SELECT_SETTINGS).first<SettingsRow>();
  if (!row) throw new Error("Missing balance settings");
  return settingsOf(row);
}

/**
 * What someone may do with 🐟额 (docs/balance-design.md §13). 转入 and
 * inviting come with an accepted invitation (admins always invite); the
 * page shows to those, and to anyone 🐟额 has records for.
 */
export async function balanceAccessFor(
  env: ApiBindings,
  userId: string,
  isAdmin: boolean,
) {
  const row = await env.DB.prepare(
    `SELECT EXISTS(SELECT 1 FROM balance_members WHERE user_id=?1) AS member,
      (EXISTS(SELECT 1 FROM balance_accounts WHERE user_id=?1)
        OR EXISTS(SELECT 1 FROM balance_topups WHERE user_id=?1)
        OR EXISTS(SELECT 1 FROM balance_withdrawals WHERE user_id=?1)
        OR EXISTS(SELECT 1 FROM balance_adjustments WHERE user_id=?1)) AS records,
      EXISTS(SELECT 1 FROM users WHERE id=?1 AND active=1) AS active`,
  )
    .bind(userId)
    .first<{ member: number; records: number; active: number }>();
  const member = row?.member === 1 && row.active === 1;
  return {
    /** The command, the user card and /me show it. */
    entry: row?.active === 1 && (member || row.records === 1 || isAdmin),
    topup: member,
    invite: member || (isAdmin && row?.active === 1),
  };
}

export async function requireBalanceEntry(
  env: ApiBindings,
  userId: string,
  isAdmin: boolean,
) {
  const access = await balanceAccessFor(env, userId, isAdmin);
  if (!access.entry)
    balanceError(404, "BALANCE_NOT_OPEN", "本功能仅对受邀用户开放。");
  return access;
}

function snapshot(settings: Required<BalanceSettingsInput>) {
  return JSON.stringify({
    topupEnabled: settings.topupEnabled,
    withdrawEnabled: settings.withdrawEnabled,
    topupFeePercent: settings.topupFeePercent,
    withdrawFeePercent: settings.withdrawFeePercent,
    withdrawMaxMinor: settings.withdrawMaxMinor,
    hongbaoEnabled: settings.hongbaoEnabled,
    transferEnabled: settings.transferEnabled,
  });
}

export async function updateBalanceSettings(
  env: ApiBindings,
  actorUserId: string,
  input: UpdateBalanceSettingsInput,
) {
  const { expectedVersion, ...change } = input;
  const previous = await readBalanceSettings(env);
  const next = {
    ...change,
    hongbaoEnabled: change.hongbaoEnabled ?? previous.hongbaoEnabled,
    transferEnabled: change.transferEnabled ?? previous.transferEnabled,
  };
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
        snapshot(next),
        expectedVersion,
      ),
      env.DB.prepare(`UPDATE balance_settings SET version=version+1,
        topup_enabled=?,withdraw_enabled=?,topup_fee_percent=?,withdraw_fee_percent=?,
        withdraw_max_minor=?,hongbao_enabled=?,transfer_enabled=?,
        updated_at=${databaseNow},updated_by_user_id=?
        WHERE id='global' AND version=?`).bind(
        Number(next.topupEnabled),
        Number(next.withdrawEnabled),
        next.topupFeePercent,
        next.withdrawFeePercent,
        next.withdrawMaxMinor,
        Number(next.hongbaoEnabled),
        Number(next.transferEnabled),
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
