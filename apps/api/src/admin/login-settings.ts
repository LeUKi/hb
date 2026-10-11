import {
  type LoginSettingChange,
  type LoginSettings,
  type LoginSettingsResponse,
  updateLoginSettingsSchema,
} from "@hb/contracts";
import { Hono } from "hono";
import { ActivityError } from "../activities/errors";
import { databaseNow } from "../activities/lifecycle";
import { ActivityValidationError } from "../activities/routes";
import { assertCsrf, requireAdmin } from "../auth/session";
import type { ApiBindings, ApiContext } from "../env";

async function readSettings(env: ApiBindings): Promise<LoginSettingsResponse> {
  const [settings, changes] = await env.DB.batch([
    env.DB.prepare(`SELECT version, liteauth_enabled AS liteauthEnabled,
      updated_at AS updatedAt, updated_by_user_id AS updatedByUserId
      FROM login_settings WHERE id='global'`),
    env.DB.prepare(`SELECT c.id,c.actor_user_id AS actorUserId,
      COALESCE(u.display_name,c.actor_user_id) AS actorDisplayName,
      c.previous_version AS previousVersion,c.next_version AS nextVersion,
      c.previous_liteauth_enabled AS previousLiteauthEnabled,
      c.liteauth_enabled AS liteauthEnabled,c.created_at AS createdAt
      FROM login_setting_changes c LEFT JOIN users u ON u.id=c.actor_user_id
      ORDER BY c.next_version DESC LIMIT 20`),
  ]);
  const config = settings?.results[0] as
    | (Omit<LoginSettings, "liteauthEnabled"> & { liteauthEnabled: number })
    | undefined;
  if (!config || !changes) throw new Error("Missing login settings");
  return {
    config: { ...config, liteauthEnabled: config.liteauthEnabled === 1 },
    recentChanges: (
      changes.results as Array<
        Omit<
          LoginSettingChange,
          "previousLiteauthEnabled" | "liteauthEnabled"
        > & {
          previousLiteauthEnabled: number;
          liteauthEnabled: number;
        }
      >
    ).map((row) => ({
      ...row,
      previousLiteauthEnabled: row.previousLiteauthEnabled === 1,
      liteauthEnabled: row.liteauthEnabled === 1,
    })),
  };
}

export const loginSettingsAdminRoutes = new Hono<ApiContext>()
  .use("*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    await next();
  })
  .get("/admin/login-settings", async (c) => {
    await requireAdmin(c);
    return c.json(await readSettings(c.env));
  })
  .patch("/admin/login-settings", async (c) => {
    const session = await requireAdmin(c);
    assertCsrf(c, session);
    const input = updateLoginSettingsSchema.safeParse(
      await c.req.json().catch(() => null),
    );
    if (!input.success)
      throw new ActivityValidationError(
        input.error.issues.map((issue) => ({
          path: issue.path.join("."),
          message: issue.message,
        })),
      );
    const { expectedVersion, liteauthEnabled } = input.data;
    try {
      await c.env.DB.batch([
        c.env.DB.prepare(`SELECT json(CASE WHEN EXISTS(
          SELECT 1 FROM login_settings WHERE id='global' AND version=?
        ) THEN '{}' ELSE '' END)`).bind(expectedVersion),
        c.env.DB.prepare(`INSERT INTO login_setting_changes
          (id,actor_user_id,previous_version,next_version,previous_liteauth_enabled,liteauth_enabled,created_at)
          SELECT ?,?,version,version+1,liteauth_enabled,?,${databaseNow}
          FROM login_settings WHERE id='global'`).bind(
          crypto.randomUUID(),
          session.user.id,
          Number(liteauthEnabled),
        ),
        c.env.DB.prepare(`UPDATE login_settings SET version=version+1,
          liteauth_enabled=?,updated_at=${databaseNow},updated_by_user_id=?
          WHERE id='global' AND version=?`).bind(
          Number(liteauthEnabled),
          session.user.id,
          expectedVersion,
        ),
        ...(liteauthEnabled
          ? []
          : [
              c.env.DB.prepare(
                "DELETE FROM oauth_attempts WHERE login_provider='liteauth'",
              ),
            ]),
      ]);
    } catch (error) {
      const current = await readSettings(c.env);
      if (current.config.version !== expectedVersion)
        throw new ActivityError(
          409,
          "LOGIN_SETTINGS_CONFLICT",
          "登录配置已在其他页面修改。当前输入已保留，请重新读取最新配置。",
        );
      throw error;
    }
    return c.json(await readSettings(c.env));
  });
