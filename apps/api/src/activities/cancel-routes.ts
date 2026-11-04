// 取消排队 (docs/claim-capacity-design.md §3 第 1 期): a direct or 口令 claim
// still waiting for its share leaves the 红包's line; nothing is taken. On a
// plain Hono mounted outside the typed chain (app.ts), as more routes there
// pass what TypeScript can instantiate (TS2589); the web calls it with fetch.
import { cancelClaimSchema } from "@hb/contracts";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { requireProtectedMutation } from "../auth/session";
import type { ApiContext } from "../env";
import { activityObject } from "../runtime/objects";
import { ActivityError, activityNotFound } from "./errors";
import { findActivity } from "./storage";

export const claimCancelRoutes = new Hono<ApiContext>().post(
  "/activities/:id/claim/cancel",
  bodyLimit({
    maxSize: 1024,
    onError: () => {
      throw new ActivityError(400, "INVALID_ACTIVITY", "取消请求无效");
    },
  }),
  async (c) => {
    const session = await requireProtectedMutation(c);
    const parsed = cancelClaimSchema.safeParse(
      await c.req.json().catch(() => null),
    );
    if (!parsed.success)
      throw new ActivityError(400, "INVALID_ACTIVITY", "取消请求无效");
    const id = c.req.param("id");
    if (!(await findActivity(c.env, id))) activityNotFound();
    return activityObject(c.env, id).fetch(
      `https://activity.internal/internal/activities/${encodeURIComponent(id)}/claim/cancel`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          userId: session.user.id,
          submissionId: parsed.data.submissionId,
        }),
      },
    );
  },
);
