import {
  ACTIVITY_LIMITS,
  type ClaimResult,
  type CreateActivityInput,
  claimActivitySchema,
  deleteActivitySchema,
  endActivitySchema,
  type ManagedActivity,
  openActivitySchema,
  type UpdateActivityInput,
} from "@hb/contracts";
import { Hono, type MiddlewareHandler, type TypedResponse } from "hono";
import { bodyLimit } from "hono/body-limit";
import { validator } from "hono/validator";
import {
  getOptionalSession,
  requireAuth,
  requireProtectedMutation,
} from "../auth/session";
import type { ApiContext } from "../env";
import {
  getClaimDetail,
  getCurrentClaim,
  listAuthorClaims,
  listPublicRecipients,
  listUserClaims,
} from "./claim-queries";
import { ActivityError } from "./errors";
import { getPublicActivity, listActivities } from "./service";

function validated<T>(
  result:
    | { success: true; data: T }
    | {
        success: false;
        error: { issues: { path: PropertyKey[]; message: string }[] };
      },
) {
  if (!result.success) {
    throw new ActivityValidationError(
      result.error.issues.map((issue) => ({
        path: issue.path.join("."),
        message: issue.message,
      })),
    );
  }
  return result.data;
}

export class ActivityValidationError extends ActivityError {
  constructor(public readonly issues: { path: string; message: string }[]) {
    super(400, "INVALID_ACTIVITY", "请检查活动配置");
  }
}

const bodySizeLimit = bodyLimit({
  maxSize: ACTIVITY_LIMITS.requestBytes,
  onError: () => {
    throw new ActivityError(413, "PAYLOAD_TOO_LARGE", "提交内容不能超过 1 MiB");
  },
});

function activityJsonTransport<T>(): MiddlewareHandler<
  ApiContext,
  string,
  { in: { json: T } }
> {
  return async (c, next) => {
    if (Number(c.req.header("Content-Length")) > ACTIVITY_LIMITS.requestBytes)
      throw new ActivityError(
        413,
        "PAYLOAD_TOO_LARGE",
        "提交内容不能超过 1 MiB",
      );
    if (
      !/^application\/([a-z.-]+\+)?json(?:\s*;|$)/i.test(
        c.req.header("Content-Type") ?? "",
      )
    )
      throw new ActivityValidationError([
        { path: "", message: "提交内容必须为 JSON" },
      ]);
    // Preserve the RPC input type without buffering the stream in this Worker.
    // ActivityDO counts the actual bytes, then strictly validates before writing.
    await next();
  };
}

const cursorQuery = validator("query", (value): { cursor?: string } => {
  if (value.cursor !== undefined && typeof value.cursor !== "string")
    throw new ActivityError(400, "INVALID_CURSOR", "分页标识无效");
  return { cursor: value.cursor };
});

function managedResponse(response: Response) {
  if (!response.ok) return response;
  // ActivityDO returns this contract after ownership checks. Forward the body
  // so up to 1,000 private rewards are not parsed and serialized again here.
  return response as Response &
    TypedResponse<{ activity: ManagedActivity }, 200, "json">;
}

export const activityRoutes = new Hono<ApiContext>()
  .use("*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    await next();
  })
  .post(
    "/activities",
    activityJsonTransport<CreateActivityInput>(),
    async (c) => {
      const session = await requireProtectedMutation(c);
      const stub = c.env.ACTIVITY_DO.get(
        c.env.ACTIVITY_DO.idFromName(`activity-create:${session.user.id}`),
      );
      // Batch encryption runs in a Durable Object's CPU budget. D1 still
      // enforces the author/request uniqueness and atomic inventory write.
      const response = await stub.fetch(
        "https://activity.internal/internal/activities/create",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-HB-Actor-ID": session.user.id,
          },
          body: c.req.raw.body,
        },
      );
      return managedResponse(response);
    },
  )
  .get("/me/activities", cursorQuery, async (c) => {
    const session = await requireAuth(c);
    return c.json(
      await listActivities(c.env, session.user.id, c.req.valid("query").cursor),
    );
  })
  .get("/me/activities/:id", async (c) => {
    const session = await requireAuth(c);
    const id = c.req.param("id");
    const stub = c.env.ACTIVITY_DO.get(c.env.ACTIVITY_DO.idFromName(id));
    const response = await stub.fetch(
      `https://activity.internal/internal/activities/${encodeURIComponent(id)}/manage`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ authorId: session.user.id }),
      },
    );
    return managedResponse(response);
  })
  .patch(
    "/me/activities/:id",
    activityJsonTransport<UpdateActivityInput>(),
    async (c) => {
      const session = await requireProtectedMutation(c);
      const id = c.req.param("id");
      const stub = c.env.ACTIVITY_DO.get(c.env.ACTIVITY_DO.idFromName(id));
      const response = await stub.fetch(
        `https://activity.internal/internal/activities/${encodeURIComponent(id)}/update`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-HB-Actor-ID": session.user.id,
          },
          body: c.req.raw.body,
        },
      );
      return managedResponse(response);
    },
  )
  .post(
    "/me/activities/:id/open",
    bodySizeLimit,
    validator("json", (value) =>
      validated(openActivitySchema.safeParse(value)),
    ),
    async (c) => {
      const session = await requireProtectedMutation(c);
      const id = c.req.param("id");
      const stub = c.env.ACTIVITY_DO.get(c.env.ACTIVITY_DO.idFromName(id));
      const response = await stub.fetch(
        `https://activity.internal/internal/activities/${encodeURIComponent(id)}/open`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            authorId: session.user.id,
            ...c.req.valid("json"),
          }),
        },
      );
      return managedResponse(response);
    },
  )
  .delete(
    "/me/activities/:id",
    bodySizeLimit,
    validator("json", (value) =>
      validated(deleteActivitySchema.safeParse(value)),
    ),
    async (c) => {
      const session = await requireProtectedMutation(c);
      const id = c.req.param("id");
      const stub = c.env.ACTIVITY_DO.get(c.env.ACTIVITY_DO.idFromName(id));
      return stub.fetch(
        `https://activity.internal/internal/activities/${encodeURIComponent(id)}/delete`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            authorId: session.user.id,
            ...c.req.valid("json"),
          }),
        },
      );
    },
  )
  .get("/activities/:id", async (c) => {
    const session = await getOptionalSession(c);
    return c.json({
      activity: await getPublicActivity(
        c.env,
        c.req.param("id"),
        session?.user.id,
      ),
    });
  })
  .post(
    "/activities/:id/claim",
    bodySizeLimit,
    validator("json", (value) =>
      validated(claimActivitySchema.safeParse(value)),
    ),
    async (c) => {
      const session = await requireProtectedMutation(c);
      const id = c.req.param("id");
      const stub = c.env.ACTIVITY_DO.get(c.env.ACTIVITY_DO.idFromName(id));
      const response = await stub.fetch(
        `https://activity.internal/internal/activities/${encodeURIComponent(id)}/claim`,
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
      return c.json((await response.json()) as ClaimResult);
    },
  )
  .get("/activities/:id/claim", async (c) => {
    const session = await requireAuth(c);
    return c.json({
      claim: await getCurrentClaim(c.env, c.req.param("id"), session.user.id),
    });
  })
  .get("/me/claims", cursorQuery, async (c) => {
    const session = await requireAuth(c);
    return c.json(
      await listUserClaims(c.env, session.user.id, c.req.valid("query").cursor),
    );
  })
  .get("/me/claims/:id", async (c) => {
    const session = await requireAuth(c);
    return c.json({
      claim: await getClaimDetail(c.env, c.req.param("id"), session.user.id),
    });
  })
  .get("/me/activities/:id/claims", cursorQuery, async (c) => {
    const session = await requireAuth(c);
    return c.json(
      await listAuthorClaims(
        c.env,
        c.req.param("id"),
        session.user.id,
        c.req.valid("query").cursor,
      ),
    );
  })
  .get("/activities/:id/recipients", cursorQuery, async (c) => {
    const session = await getOptionalSession(c);
    return c.json(
      await listPublicRecipients(
        c.env,
        c.req.param("id"),
        session?.user.id,
        c.req.valid("query").cursor,
      ),
    );
  })
  .post(
    "/me/activities/:id/end",
    bodySizeLimit,
    validator("json", (value) => validated(endActivitySchema.safeParse(value))),
    async (c) => {
      const session = await requireProtectedMutation(c);
      const id = c.req.param("id");
      const stub = c.env.ACTIVITY_DO.get(c.env.ACTIVITY_DO.idFromName(id));
      const response = await stub.fetch(
        `https://activity.internal/internal/activities/${encodeURIComponent(id)}/end`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            authorId: session.user.id,
            ...c.req.valid("json"),
          }),
        },
      );
      return managedResponse(response);
    },
  );
