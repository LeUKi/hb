import {
  ACTIVITY_LIMITS,
  type ActivityRewardFilter,
  activityRewardFilterSchema,
  type GlobalRedemptionResult,
  globalRedemptionSchema,
} from "@hb/contracts";
import { Hono, type TypedResponse } from "hono";
import { bodyLimit } from "hono/body-limit";
import { validator } from "hono/validator";
import { ActivityError } from "../activities/errors";
import { ActivityValidationError } from "../activities/routes";
import {
  getOptionalSession,
  requireAuth,
  requireProtectedMutation,
} from "../auth/session";
import type { ApiContext } from "../env";
import { listSquare, listTopic } from "./service";
import { getStatistics } from "./statistics";

const cursorQuery = validator("query", (value): { cursor?: string } => {
  if (value.cursor !== undefined && typeof value.cursor !== "string")
    throw new ActivityError(400, "INVALID_CURSOR", "分页标识无效");
  return { cursor: value.cursor };
});

const topicQuery = validator(
  "query",
  (value): { cursor?: string; postNumber: number } => {
    if (value.cursor !== undefined && typeof value.cursor !== "string")
      throw new ActivityError(400, "INVALID_CURSOR", "分页标识无效");
    const raw = value.postNumber ?? "1";
    if (typeof raw !== "string" || !/^[0-9]{1,16}$/.test(raw))
      throw new ActivityError(400, "INVALID_TOPIC", "回复楼层无效");
    const postNumber = Number(raw);
    if (!Number.isSafeInteger(postNumber) || postNumber <= 0)
      throw new ActivityError(400, "INVALID_TOPIC", "回复楼层无效");
    return { cursor: value.cursor, postNumber };
  },
);

export const discoveryRoutes = new Hono<ApiContext>()
  .use("*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    await next();
  })
  .post(
    "/redemptions/discover",
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
      const checked = globalRedemptionSchema.safeParse(value);
      if (!checked.success)
        throw new ActivityValidationError(
          checked.error.issues.map((issue) => ({
            path: issue.path.join("."),
            message: issue.message,
          })),
        );
      return checked.data;
    }),
    async (c) => {
      const session = await requireProtectedMutation(c);
      const stub = c.env.ACTIVITY_DO.get(
        c.env.ACTIVITY_DO.idFromName(`global-redemption:${session.user.id}`),
      );
      const response = await stub.fetch(
        "https://activity.internal/internal/redemptions/discover",
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
      return response as Response &
        TypedResponse<Omit<GlobalRedemptionResult, "claimResult">, 200, "json">;
    },
  )
  .post(
    "/redemptions",
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
      const checked = globalRedemptionSchema.safeParse(value);
      if (!checked.success)
        throw new ActivityValidationError(
          checked.error.issues.map((issue) => ({
            path: issue.path.join("."),
            message: issue.message,
          })),
        );
      return checked.data;
    }),
    async (c) => {
      const session = await requireProtectedMutation(c);
      const stub = c.env.ACTIVITY_DO.get(
        c.env.ACTIVITY_DO.idFromName(`global-redemption:${session.user.id}`),
      );
      const response = await stub.fetch(
        "https://activity.internal/internal/redemptions/submit",
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
      return response as Response &
        TypedResponse<GlobalRedemptionResult, 200, "json">;
    },
  )
  .get("/redemptions/:id", cursorQuery, async (c) => {
    const session = await requireAuth(c);
    const stub = c.env.ACTIVITY_DO.get(
      c.env.ACTIVITY_DO.idFromName(`global-redemption:${session.user.id}`),
    );
    const response = await stub.fetch(
      "https://activity.internal/internal/redemptions/refresh",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          userId: session.user.id,
          id: c.req.param("id"),
          cursor: c.req.valid("query").cursor,
        }),
      },
    );
    if (!response.ok) return response;
    return response as Response &
      TypedResponse<GlobalRedemptionResult, 200, "json">;
  })
  .get(
    "/discovery/activities",
    validator(
      "query",
      (
        value,
      ): {
        status: "all" | "active" | "ended";
        type: ActivityRewardFilter;
        cursor?: string;
      } => {
        const status = value.status ?? "all";
        if (status !== "all" && status !== "active" && status !== "ended")
          throw new ActivityError(400, "INVALID_STATUS", "红包状态无效");
        if (value.cursor !== undefined && typeof value.cursor !== "string")
          throw new ActivityError(400, "INVALID_CURSOR", "分页标识无效");
        const type = activityRewardFilterSchema.safeParse(value.type ?? "all");
        if (!type.success)
          throw new ActivityError(400, "INVALID_TYPE", "奖励类型无效");
        return { status, type: type.data, cursor: value.cursor };
      },
    ),
    async (c) => {
      const session = await getOptionalSession(c);
      const query = c.req.valid("query");
      return c.json(
        await listSquare(
          c.env,
          query.status,
          session?.user.id,
          query.cursor,
          query.type,
        ),
      );
    },
  )
  .get("/topics/:topicId/activities", topicQuery, async (c) => {
    const session = await getOptionalSession(c);
    return c.json(
      await listTopic(
        c.env,
        c.req.param("topicId"),
        session?.user.id,
        c.req.valid("query").cursor,
        c.req.valid("query").postNumber,
      ),
    );
  })
  .get("/me/activities/:id/statistics", cursorQuery, async (c) => {
    const session = await requireAuth(c);
    return c.json(
      await getStatistics(
        c.env,
        c.req.param("id"),
        session.user.id,
        c.req.valid("query").cursor,
      ),
    );
  });
