// 判定器设置 (redesign/07 §10, docs/programmable-hongbao-design.md §1, §5,
// §7): one versioned row, written as 🐟额's settings are (a version guard,
// the change, then the row by version, in one batch).
import type {
  JudgeSettingChange,
  JudgeSettings,
  JudgeSettingsInput,
  UpdateJudgeSettingsInput,
} from "@hb/contracts";
import { ActivityError } from "../activities/errors";
import { databaseNow } from "../activities/lifecycle";
import type { ApiBindings } from "../env";

type SettingsRow = {
  version: number;
  enabled: number;
  daily_open_limit: number;
  daily_deploy_limit: number;
  monthly_limit: number;
  updated_at: number;
};

export async function readJudgeSettings(
  env: ApiBindings,
): Promise<JudgeSettings> {
  const row = await env.DB.prepare(
    `SELECT version,enabled,daily_open_limit,daily_deploy_limit,monthly_limit,updated_at
    FROM judge_settings WHERE id='global'`,
  ).first<SettingsRow>();
  if (!row) throw new Error("Missing judge settings");
  return {
    version: row.version,
    enabled: row.enabled === 1,
    dailyOpenLimit: row.daily_open_limit,
    dailyDeployLimit: row.daily_deploy_limit,
    monthlyLimit: row.monthly_limit,
    updatedAt: row.updated_at,
  };
}

function snapshot(settings: JudgeSettingsInput) {
  return JSON.stringify({
    enabled: settings.enabled,
    dailyOpenLimit: settings.dailyOpenLimit,
    dailyDeployLimit: settings.dailyDeployLimit,
    monthlyLimit: settings.monthlyLimit,
  });
}

export async function updateJudgeSettings(
  env: ApiBindings,
  actorUserId: string,
  input: UpdateJudgeSettingsInput,
) {
  const { expectedVersion, ...next } = input;
  const previous = await readJudgeSettings(env);
  try {
    await env.DB.batch([
      env.DB.prepare(`SELECT json(CASE WHEN EXISTS(
        SELECT 1 FROM judge_settings WHERE id='global' AND version=?
      ) THEN '{}' ELSE '' END)`).bind(expectedVersion),
      env.DB.prepare(`INSERT INTO judge_setting_changes
        (id,actor_user_id,previous_version,next_version,previous,next,created_at)
        SELECT ?,?,version,version+1,?,?,${databaseNow}
        FROM judge_settings WHERE id='global' AND version=?`).bind(
        crypto.randomUUID(),
        actorUserId,
        snapshot(previous),
        snapshot(next),
        expectedVersion,
      ),
      env.DB.prepare(`UPDATE judge_settings SET version=version+1,
        enabled=?,daily_open_limit=?,daily_deploy_limit=?,monthly_limit=?,
        updated_at=${databaseNow},updated_by_user_id=?
        WHERE id='global' AND version=?`).bind(
        Number(next.enabled),
        next.dailyOpenLimit,
        next.dailyDeployLimit,
        next.monthlyLimit,
        actorUserId,
        expectedVersion,
      ),
    ]);
  } catch (error) {
    if ((await readJudgeSettings(env)).version !== expectedVersion)
      throw new ActivityError(
        409,
        "JUDGE_SETTINGS_CONFLICT",
        "判定器设置已经变了，请刷新后再试。当前输入已保留。",
      );
    throw error;
  }
  return readJudgeSettings(env);
}

export async function recentJudgeSettingChanges(
  env: ApiBindings,
): Promise<JudgeSettingChange[]> {
  const rows = await env.DB.prepare(
    `SELECT c.id,c.actor_user_id AS actorUserId,COALESCE(u.display_name,c.actor_user_id) AS actorDisplayName,
      c.previous_version AS previousVersion,c.next_version AS nextVersion,c.previous,c.next,c.created_at AS createdAt
    FROM judge_setting_changes c LEFT JOIN users u ON u.id=c.actor_user_id
    ORDER BY c.created_at DESC,c.id DESC LIMIT 20`,
  ).all<
    Omit<JudgeSettingChange, "previous" | "next"> & {
      previous: string;
      next: string;
    }
  >();
  return rows.results.map((row) => ({
    ...row,
    previous: JSON.parse(row.previous) as JudgeSettingsInput,
    next: JSON.parse(row.next) as JudgeSettingsInput,
  }));
}
