import { rankQuerySchema, rankVisibilityInputSchema } from "@hb/contracts";
import { Hono } from "hono";
import { validator } from "hono/validator";
import { ActivityError } from "../activities/errors";
import {
  getOptionalSession,
  requireAuth,
  requireProtectedMutation,
} from "../auth/session";
import type { ApiContext } from "../env";
import { rankPage, rankVisibility, setRankVisibility } from "./service";

// 排行榜 (docs/leaderboard-design.md §4): anyone may read it; the one
// reading also gets their own place and switch.

export const rankRoutes = new Hono<ApiContext>()
  .use("*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    await next();
  })
  .get(
    "/rank",
    validator("query", (value) => {
      const parsed = rankQuerySchema.safeParse(value);
      if (!parsed.success)
        throw new ActivityError(400, "INVALID_RANK", "排行榜参数无效");
      return parsed.data;
    }),
    async (c) => {
      const session = await getOptionalSession(c);
      return c.json(
        await rankPage(c.env, c.req.valid("query"), session?.user.id ?? null),
      );
    },
  )
  .get("/me/rank-visibility", async (c) => {
    const session = await requireAuth(c);
    return c.json(await rankVisibility(c.env, session.user.id));
  })
  .patch(
    "/me/rank-visibility",
    validator("json", (value) => {
      const parsed = rankVisibilityInputSchema.safeParse(value);
      if (!parsed.success)
        throw new ActivityError(400, "INVALID_RANK", "排行榜设置无效");
      return parsed.data;
    }),
    async (c) => {
      const session = await requireProtectedMutation(c);
      const { board, visible } = c.req.valid("json");
      return c.json(
        await setRankVisibility(c.env, session.user.id, board, visible),
      );
    },
  );
