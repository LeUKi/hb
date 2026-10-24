// 代码判定红包's own routes (docs/programmable-hongbao-design.md): 部署
// (§5), a claimant's 我的提交 (§3), its sender's records (§6), and the
// 站长's 停用 (§1) and 判定器 tab (redesign/07 §10).
import {
  ACTIVITY_LIMITS,
  judgeCheckInputSchema,
  updateJudgeSettingsSchema,
} from "@hb/contracts";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { validator } from "hono/validator";
import { ActivityError } from "../activities/errors";
import { ActivityValidationError } from "../activities/routes";
import {
  requireAdmin,
  requireAdminMutation,
  requireAuth,
  requireProtectedMutation,
} from "../auth/session";
import type { ApiContext } from "../env";
import { activityObject } from "../runtime/objects";
import { checkJudge } from "./check";
import { myJudgments } from "./mine";
import { judgeRecords, listFailures } from "./records";
import {
  readJudgeSettings,
  recentJudgeSettingChanges,
  updateJudgeSettings,
} from "./settings";
import { judgeUsageReport } from "./usage";

export const judgeRoutes = new Hono<ApiContext>()
  .use("*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    await next();
  })
  .post(
    "/judge/check",
    bodyLimit({
      maxSize: ACTIVITY_LIMITS.requestBytes,
      onError: () => {
        throw new ActivityError(
          413,
          "PAYLOAD_TOO_LARGE",
          "提交内容不能超过 1 MiB",
        );
      },
    }),
    validator("json", (value) => {
      const parsed = judgeCheckInputSchema.safeParse(value);
      if (!parsed.success)
        throw new ActivityValidationError(
          parsed.error.issues.map((issue) => ({
            path: issue.path.join("."),
            message: issue.message,
          })),
        );
      return parsed.data;
    }),
    async (c) => {
      const session = await requireProtectedMutation(c);
      return c.json({
        check: await checkJudge(c.env, session.user.id, c.req.valid("json")),
      });
    },
  )
  // 我的提交: the viewer's own, twenty at a time.
  .get(
    "/activities/:id/judgments",
    validator("query", (value) => {
      const cursor = value.cursor;
      if (
        cursor !== undefined &&
        (typeof cursor !== "string" || !/^[1-9]\d{0,8}$/.test(cursor))
      )
        throw new ActivityValidationError([
          { path: "cursor", message: "分页位置无效" },
        ]);
      return { cursor: cursor === undefined ? null : Number(cursor) };
    }),
    async (c) => {
      const session = await requireAuth(c);
      return c.json(
        await myJudgments(
          c.env,
          c.req.param("id"),
          session.user.id,
          c.req.valid("query").cursor,
        ),
      );
    },
  )
  .get("/me/activities/:id/code-failures", async (c) => {
    const session = await requireAuth(c);
    return c.json(
      await listFailures(c.env, c.req.param("id"), session.user.id),
    );
  })
  // 下载完整记录: for the kit's npm run replay.
  .get("/me/activities/:id/judge-records", async (c) => {
    const session = await requireAuth(c);
    const id = c.req.param("id");
    const records = await judgeRecords(c.env, id, session.user.id);
    // A file to save, not an RPC answer: its state is any JSON.
    return new Response(JSON.stringify(records), {
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Disposition": `attachment; filename="judge-records-${id}.json"`,
        "Cache-Control": "no-store",
      },
    });
  })
  .post("/admin/activities/:id/stop-code", async (c) => {
    const session = await requireAdminMutation(c);
    const id = c.req.param("id");
    const response = await activityObject(c.env, id).fetch(
      `https://activity.internal/internal/activities/${encodeURIComponent(id)}/stop`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ adminId: session.user.id }),
      },
    );
    if (!response.ok) return response;
    return c.json({ status: "stopped" as const });
  })
  // 网站管理 · 判定器 (redesign/07 §10).
  .get("/admin/judge/settings", async (c) => {
    await requireAdmin(c);
    const [settings, recentChanges] = await Promise.all([
      readJudgeSettings(c.env),
      recentJudgeSettingChanges(c.env),
    ]);
    return c.json({ settings, recentChanges });
  })
  .put(
    "/admin/judge/settings",
    bodyLimit({
      maxSize: 32 * 1024,
      onError: () => {
        throw new ActivityError(413, "PAYLOAD_TOO_LARGE", "提交内容过大");
      },
    }),
    async (c) => {
      const session = await requireAdminMutation(c);
      const parsed = updateJudgeSettingsSchema.safeParse(
        await c.req.json().catch(() => null),
      );
      if (!parsed.success)
        throw new ActivityValidationError(
          parsed.error.issues.map((issue) => ({
            path: issue.path.join("."),
            message: issue.message,
          })),
        );
      return c.json({
        settings: await updateJudgeSettings(
          c.env,
          session.user.id,
          parsed.data,
        ),
      });
    },
  )
  .get("/admin/judge/usage", async (c) => {
    await requireAdmin(c);
    return c.json(
      await judgeUsageReport(c.env, await readJudgeSettings(c.env)),
    );
  });
