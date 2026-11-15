// 个人令牌's own routes (docs/personal-token-design.md §5): made, listed and
// stopped from the page only, with the cookie, the exact Origin and CSRF. A
// token can never make, see or stop tokens, its own included.
import {
  adminRevokePersonalTokenSchema,
  createPersonalTokenSchema,
  PERSONAL_TOKEN_LIMITS,
} from "@hb/contracts";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { validator } from "hono/validator";
import { ActivityError } from "../activities/errors";
import type { ApiContext } from "../env";
import {
  adminRevokePersonalToken,
  createPersonalToken,
  listPersonalTokens,
  revokeOwnPersonalToken,
} from "./personal-token";
import {
  requireAdminMutation,
  requireAuth,
  requireProtectedMutation,
} from "./session";

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
