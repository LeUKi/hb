import {
  ACTIVITY_LIMITS,
  passwordSolveSchema,
  type SolveResult,
} from "@hb/contracts";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { validator } from "hono/validator";
import { getOptionalSession, requireProtectedMutation } from "../auth/session";
import type { ApiContext } from "../env";
import { ActivityError } from "./errors";
import { getActivityPasswords } from "./password-service";
import { ActivityValidationError } from "./routes";

export const passwordRoutes = new Hono<ApiContext>()
  .use("*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    await next();
  })
  .get("/activities/:id/passwords", async (c) => {
    const session = await getOptionalSession(c);
    return c.json(
      await getActivityPasswords(c.env, c.req.param("id"), session?.user.id),
    );
  })
  .post(
    "/activities/:id/password-solves",
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
      const parsed = passwordSolveSchema.safeParse(value);
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
      const id = c.req.param("id");
      const object = c.env.ACTIVITY_DO.get(c.env.ACTIVITY_DO.idFromName(id));
      const response = await object.fetch(
        `https://activity.internal/internal/activities/${encodeURIComponent(id)}/solve`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            userId: session.user.id,
            ...c.req.valid("json"),
          }),
        },
      );
      if (!response.ok) return response;
      return c.json((await response.json()) as SolveResult);
    },
  );
