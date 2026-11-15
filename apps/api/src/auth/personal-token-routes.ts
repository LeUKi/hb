// 个人令牌's own routes (docs/personal-token-design.md §5): made, listed and
// stopped from the page only, with the cookie, the exact Origin and CSRF. A
// token can never make, see or stop tokens, its own included.
import {
  adminRevokePersonalTokenSchema,
  createPersonalTokenSchema,
  PERSONAL_TOKEN_LIMITS,
  PERSONAL_TOKEN_RATE_LIMITS,
  type PersonalTokenAdminView,
  updatePersonalTokenSettingsSchema,
} from "@hb/contracts";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { validator } from "hono/validator";
import { ActivityError } from "../activities/errors";
import type { ApiBindings, ApiContext } from "../env";
import {
  adminRevokePersonalToken,
  createPersonalToken,
  listPersonalTokens,
  revokeOwnPersonalToken,
} from "./personal-token";
import {
  busiestTokenAccounts,
  myTokenUsage,
  tokenUsage,
} from "./personal-token-stats";
import {
  requireAdmin,
  requireAdminMutation,
  requireAuth,
  requireProtectedMutation,
} from "./session";

/** The 站长's switch for every request with a token (§8). */
async function tokenSettingsOf(env: ApiBindings) {
  const row = await env.DB.prepare(
    "SELECT enabled, version, updated_at FROM personal_token_settings WHERE id='global'",
  ).first<{ enabled: number; version: number; updated_at: number }>();
  return row
    ? {
        enabled: row.enabled === 1,
        version: row.version,
        updatedAt: new Date(row.updated_at).toISOString(),
      }
    : { enabled: true, version: 0, updatedAt: new Date(0).toISOString() };
}

const body = bodyLimit({
  maxSize: 4096,
  onError: () => {
    throw new ActivityError(413, "PAYLOAD_TOO_LARGE", "提交内容太大");
  },
});

/** Token management is the page's: a request carrying a token is refused. */
function refuseToken(authorization: string | undefined) {
  if (authorization !== undefined && /^Bearer\s/i.test(authorization))
    throw new ActivityError(
      403,
      "PERSONAL_TOKEN_NOT_ALLOWED",
      "令牌只能在网页上管理",
    );
}

export const personalTokenRoutes = new Hono<ApiContext>()
  .use("/me/personal-tokens", async (c, next) => {
    c.header("Cache-Control", "no-store");
    refuseToken(c.req.header("Authorization"));
    await next();
  })
  .use("/me/personal-tokens/*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    refuseToken(c.req.header("Authorization"));
    await next();
  })
  .get("/me/personal-tokens", async (c) => {
    const session = await requireAuth(c);
    return c.json({
      items: await listPersonalTokens(c.env, session.user.id),
      max: PERSONAL_TOKEN_LIMITS.activeMax,
    });
  })
  // Their own usage (§8): by hour for a day, by day for 30, each token's.
  .get("/me/personal-tokens/usage", async (c) => {
    const session = await requireAuth(c);
    return c.json({
      usage: await myTokenUsage(c.env, session.user.id),
      limits: PERSONAL_TOKEN_RATE_LIMITS,
    });
  })
  .post(
    "/me/personal-tokens",
    body,
    validator("json", (value) => {
      const parsed = createPersonalTokenSchema.safeParse(value);
      if (!parsed.success)
        throw new ActivityError(
          400,
          "INVALID_PERSONAL_TOKEN_INPUT",
          parsed.error.issues[0]?.message ?? "请检查名称和有效期",
        );
      return parsed.data;
    }),
    async (c) => {
      const session = await requireProtectedMutation(c);
      return c.json(
        await createPersonalToken(c.env, session.user.id, c.req.valid("json")),
      );
    },
  )
  .post("/me/personal-tokens/:id/revoke", async (c) => {
    const session = await requireProtectedMutation(c);
    return c.json({
      personalToken: await revokeOwnPersonalToken(
        c.env,
        session.user.id,
        c.req.param("id"),
      ),
    });
  })
  // The 站长's (§8): the switch, everyone's usage and who calls most.
  .get("/admin/personal-tokens", async (c) => {
    refuseToken(c.req.header("Authorization"));
    await requireAdmin(c);
    const [settings, usage, topUsers] = await Promise.all([
      tokenSettingsOf(c.env),
      tokenUsage(c.env),
      busiestTokenAccounts(c.env),
    ]);
    return c.json({
      settings,
      limits: PERSONAL_TOKEN_RATE_LIMITS,
      usage,
      topUsers,
    } satisfies PersonalTokenAdminView);
  })
  .patch("/admin/personal-tokens/settings", body, async (c) => {
    refuseToken(c.req.header("Authorization"));
    const session = await requireAdminMutation(c);
    const input = updatePersonalTokenSettingsSchema.safeParse(
      await c.req.json().catch(() => null),
    );
    if (!input.success)
      throw new ActivityError(400, "INVALID_TOKEN_SETTINGS", "设置无效");
    const saved = await c.env.DB.prepare(
      `UPDATE personal_token_settings SET enabled=?,version=version+1,updated_by=?,updated_at=?
       WHERE id='global' AND version=?`,
    )
      .bind(
        input.data.enabled ? 1 : 0,
        session.user.id,
        Date.now(),
        input.data.expectedVersion,
      )
      .run();
    if (saved.meta.changes === 0)
      throw new ActivityError(
        409,
        "TOKEN_SETTINGS_CHANGED",
        "设置刚被改过，刷新后再改。",
      );
    console.info(
      JSON.stringify({
        event: "personal_tokens_switched",
        enabled: input.data.enabled,
      }),
    );
    return c.json({ settings: await tokenSettingsOf(c.env) });
  })
  .post(
    "/admin/personal-tokens/:id/revoke",
    body,
    validator("json", (value) => {
      const parsed = adminRevokePersonalTokenSchema.safeParse(value);
      if (!parsed.success)
        throw new ActivityError(
          400,
          "INVALID_REVOKE_REASON",
          parsed.error.issues[0]?.message ?? "请填原因",
        );
      return parsed.data;
    }),
    async (c) => {
      refuseToken(c.req.header("Authorization"));
      const session = await requireAdminMutation(c);
      return c.json({
        personalToken: await adminRevokePersonalToken(
          c.env,
          session.user.id,
          c.req.param("id"),
          c.req.valid("json").reason,
        ),
      });
    },
  );
