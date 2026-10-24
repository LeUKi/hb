// 代码判定红包's own route: 在线检查 (docs/programmable-hongbao-design.md §5).
import { ACTIVITY_LIMITS, judgeCheckInputSchema } from "@hb/contracts";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { validator } from "hono/validator";
import { ActivityError } from "../activities/errors";
import { ActivityValidationError } from "../activities/routes";
import { requireProtectedMutation } from "../auth/session";
import type { ApiContext } from "../env";
import { checkJudge } from "./check";

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
  );
