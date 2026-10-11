import {
  type AttemptRateLimitChange,
  type AttemptRateLimits,
  type AttemptRateLimitsResponse,
  updateAttemptRateLimitsSchema,
} from "@hb/contracts";
import { Hono } from "hono";
import { ActivityError } from "../activities/errors";
import { databaseNow } from "../activities/lifecycle";
import { ActivityValidationError } from "../activities/routes";
import { assertCsrf, requireAdmin } from "../auth/session";
import type { ApiBindings, ApiContext } from "../env";

async function readConfig(
  env: ApiBindings,
): Promise<AttemptRateLimitsResponse> {
  const [configResult, changesResult] = await env.DB.batch([
    env.DB.prepare(`SELECT version, home_interval_seconds AS homeIntervalSeconds,
      activity_interval_seconds AS activityIntervalSeconds, updated_at AS updatedAt,
      updated_by_user_id AS updatedByUserId FROM attempt_rate_limits WHERE id='global'`),
    env.DB.prepare(`SELECT c.id, c.actor_user_id AS actorUserId,
      COALESCE(u.display_name,c.actor_user_id) AS actorDisplayName,
      c.previous_version AS previousVersion, c.next_version AS nextVersion,
      c.previous_home_interval_seconds AS previousHomeIntervalSeconds,
      c.home_interval_seconds AS homeIntervalSeconds,
      c.previous_activity_interval_seconds AS previousActivityIntervalSeconds,
      c.activity_interval_seconds AS activityIntervalSeconds, c.created_at AS createdAt
      FROM attempt_rate_limit_changes c LEFT JOIN users u ON u.id=c.actor_user_id
      ORDER BY c.next_version DESC LIMIT 20`),
  ]);
  if (!configResult || !changesResult)
    throw new Error("Missing rate configuration response");
  const config = configResult.results[0] as AttemptRateLimits | undefined;
  if (!config) throw new Error("Missing attempt rate configuration");
  return {
    config,
    recentChanges: changesResult.results as AttemptRateLimitChange[],
  };
}

export const adminRoutes = new Hono<ApiContext>()
  .use("*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    await next();
  })
  .get("/admin/rate-limits", async (c) => {
    await requireAdmin(c);
    return c.json(await readConfig(c.env));
  })
  .patch("/admin/rate-limits", async (c) => {
    const session = await requireAdmin(c);
    assertCsrf(c, session);
    const input = updateAttemptRateLimitsSchema.safeParse(
      await c.req.json().catch(() => null),
    );
    if (!input.success)
      throw new ActivityValidationError(
        input.error.issues.map((issue) => ({
          path: issue.path.join("."),
          message: issue.message,
        })),
      );
    const { expectedVersion, homeIntervalSeconds, activityIntervalSeconds } =
      input.data;
    try {
      await c.env.DB.batch([
        // Abort the whole batch before recording an audit if the version is stale.
        c.env.DB.prepare(`SELECT json(CASE WHEN EXISTS(
          SELECT 1 FROM attempt_rate_limits WHERE id='global' AND version=?
        ) THEN '{}' ELSE '' END)`).bind(expectedVersion),
        c.env.DB.prepare(`INSERT INTO attempt_rate_limit_changes
          (id,actor_user_id,previous_version,next_version,previous_home_interval_seconds,
          home_interval_seconds,previous_activity_interval_seconds,activity_interval_seconds,created_at)
          SELECT ?,?,version,version+1,home_interval_seconds,?,activity_interval_seconds,?,${databaseNow}
          FROM attempt_rate_limits WHERE id='global'`).bind(
          crypto.randomUUID(),
          session.user.id,
          homeIntervalSeconds,
          activityIntervalSeconds,
        ),
        c.env.DB.prepare(`UPDATE attempt_rate_limits SET version=version+1,
          home_interval_seconds=?,activity_interval_seconds=?,updated_at=${databaseNow},updated_by_user_id=?
          WHERE id='global' AND version=?`).bind(
          homeIntervalSeconds,
          activityIntervalSeconds,
          session.user.id,
          expectedVersion,
        ),
      ]);
    } catch (error) {
      const current = await readConfig(c.env);
      if (current.config.version !== expectedVersion)
        throw new ActivityError(
          409,
          "RATE_LIMIT_CONFIG_CONFLICT",
          "配置已在其他页面修改。当前输入已保留，请重新读取最新配置。",
        );
      throw error;
    }
    return c.json(await readConfig(c.env));
  });
