// 代码判定红包's own routes (docs/programmable-hongbao-design.md): 在线检查
// (§5), its sender's records (§6) and the 站长's 停用 (§1).
import { ACTIVITY_LIMITS, judgeCheckInputSchema } from "@hb/contracts";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { HTTPException } from "hono/http-exception";
import { validator } from "hono/validator";
import { ActivityError } from "../activities/errors";
import { ActivityValidationError } from "../activities/routes";
import { requireAuth, requireProtectedMutation } from "../auth/session";
import type { ApiContext } from "../env";
import { activityObject } from "../runtime/objects";
import { checkJudge } from "./check";
import { judgeRecords, listFailures } from "./records";

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
    const session = await requireProtectedMutation(c);
    if (!session.user.isAdmin)
      throw new HTTPException(403, { message: "此页面仅限管理员访问" });
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
  });
