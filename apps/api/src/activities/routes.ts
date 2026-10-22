import {
  ACTIVITY_LIMITS,
  type ActivityHistoryFilters,
  activityRewardFilterSchema,
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
  listActivityPayments,
  listPaymentActivities,
} from "../payments/activity-queries";
import { resendClaimPayment } from "../payments/resend";
import { activityObject, creationObject } from "../runtime/objects";
import { assertExactOrigin } from "../security/http";
import {
  getClaimDetail,
  getCurrentClaim,
  listAuthorClaims,
  listPublicRecipients,
  listUserClaims,
} from "./claim-queries";
import { ActivityError, activityNotFound } from "./errors";
import { humanCheckOf, passesHumanCheck } from "./human-check";
import { LIVE_USER_HEADER } from "./live";
import { activityProofData } from "./random-proof";
import {
  accountHistorySummary,
  getCurrentParticipation,
  getCurrentParticipationForActivity,
  getCurrentRegistration,
  listAuthorRegistrations,
  listParticipations,
  listPublicRegistrations,
} from "./registration-queries";
import { getPublicActivity, listActivities } from "./service";
import { findActivity } from "./storage";

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
    super(400, "INVALID_ACTIVITY", "请检查红包配置");
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
const historyQuery = validator(
  "query",
  (value): ActivityHistoryFilters & { cursor?: string } => {
    const type = activityRewardFilterSchema.safeParse(value.type ?? "all");
    if (!type.success)
      throw new ActivityError(400, "INVALID_TYPE", "红包类型无效");
    const status = value.status ?? "all";
    if (
      status !== "all" &&
      status !== "draft" &&
      status !== "active" &&
      status !== "ended" &&
      status !== "archived" &&
      status !== "finished"
    )
      throw new ActivityError(400, "INVALID_STATUS", "红包状态无效");
    if (value.cursor !== undefined && typeof value.cursor !== "string")
      throw new ActivityError(400, "INVALID_CURSOR", "分页标识无效");
    return { type: type.data, status, cursor: value.cursor };
  },
);
const paymentActivityQuery = validator(
  "query",
  (
    value,
  ): { status: "all" | "active" | "ended" | "archived"; cursor?: string } => {
    const status = value.status ?? "all";
    if (
      status !== "all" &&
      status !== "active" &&
      status !== "ended" &&
      status !== "archived"
    )
      throw new ActivityError(400, "INVALID_STATUS", "红包状态无效");
    if (value.cursor !== undefined && typeof value.cursor !== "string")
      throw new ActivityError(400, "INVALID_CURSOR", "分页标识无效");
    return { status, cursor: value.cursor };
  },
);
const paymentTargetQuery = validator(
  "query",
  (value): { status: "all" | "pending" | "confirmed"; cursor?: string } => {
    const status = value.status ?? "all";
    if (status !== "all" && status !== "pending" && status !== "confirmed")
      throw new ActivityError(400, "INVALID_STATUS", "付款状态无效");
    if (value.cursor !== undefined && typeof value.cursor !== "string")
      throw new ActivityError(400, "INVALID_CURSOR", "分页标识无效");
    return { status, cursor: value.cursor };
  },
);
const participationQuery = validator("query", (value): { refresh: boolean } => {
  if (
    value.refresh !== undefined &&
    value.refresh !== "0" &&
    value.refresh !== "1"
  )
    throw new ActivityError(400, "INVALID_REFRESH", "刷新参数无效");
  return { refresh: value.refresh !== "0" };
});

async function requireLdcActivity(env: ApiContext["Bindings"], id: string) {
  const activity = await findActivity(env, id);
  if (!activity) activityNotFound();
  return activity;
}

async function requireOwnedLdcActivity(
  env: ApiContext["Bindings"],
  id: string,
  userId: string,
) {
  const activity = await requireLdcActivity(env, id);
  if (activity.authorId !== userId) activityNotFound();
  return activity;
}

async function requireOwnedLdcActivityForDelete(
  env: ApiContext["Bindings"],
  id: string,
  userId: string,
) {
  const row = await env.DB.prepare(
    "SELECT author_id FROM activities WHERE id = ? AND reward_type = 'ldc'",
  )
    .bind(id)
    .first<{ author_id: string }>();
  if (!row || row.author_id !== userId) activityNotFound();
}

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
      const stub = creationObject(c.env, session.user.id);
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
  .get("/me/activities", historyQuery, async (c) => {
    const session = await requireAuth(c);
    const query = c.req.valid("query");
    return c.json(
      await listActivities(c.env, session.user.id, query.cursor, query),
    );
  })
  .get("/me/participations", historyQuery, async (c) => {
    const session = await requireAuth(c);
    const query = c.req.valid("query");
    return c.json(
      await listParticipations(c.env, session.user.id, query.cursor, query),
    );
  })
  .get("/me/history-summary", async (c) => {
    const session = await requireAuth(c);
    return c.json(await accountHistorySummary(c.env, session.user.id));
  })
  .get("/me/payment-activities", paymentActivityQuery, async (c) => {
    const session = await requireAuth(c);
    const query = c.req.valid("query");
    return c.json(
      await listPaymentActivities(
        c.env,
        session.user.id,
        query.status,
        query.cursor,
      ),
    );
  })
  .get("/me/activities/:id/payments", paymentTargetQuery, async (c) => {
    const session = await requireAuth(c);
    const query = c.req.valid("query");
    return c.json(
      await listActivityPayments(
        c.env,
        c.req.param("id"),
        session.user.id,
        query.status,
        query.cursor,
      ),
    );
  })
  .get("/activities/:id/registrations", cursorQuery, async (c) => {
    const session = await getOptionalSession(c);
    return c.json(
      await listPublicRegistrations(
        c.env,
        c.req.param("id"),
        session?.user.id,
        c.req.valid("query").cursor,
      ),
    );
  })
  .get("/me/activities/:id/registrations", cursorQuery, async (c) => {
    const session = await requireAuth(c);
    return c.json(
      await listAuthorRegistrations(
        c.env,
        c.req.param("id"),
        session.user.id,
        c.req.valid("query").cursor,
      ),
    );
  })
  .get("/activities/:id/registration", async (c) => {
    const session = await requireAuth(c);
    const id = c.req.param("id");
    const activity = await findActivity(c.env, id);
    if (
      !activity ||
      (activity.openedAt === null && activity.authorId !== session.user.id)
    )
      activityNotFound();
    const object = activityObject(c.env, id);
    await object.fetch(
      `https://activity.internal/internal/activities/${id}/refresh`,
      { method: "POST" },
    );
    return c.json({
      registration: await getCurrentRegistration(c.env, id, session.user.id),
    });
  })
  .get("/activities/:id/participation", participationQuery, async (c) => {
    const session = await requireAuth(c);
    const id = c.req.param("id");
    const activity = await findActivity(c.env, id);
    if (
      !activity ||
      (activity.openedAt === null && activity.authorId !== session.user.id)
    )
      activityNotFound();

    if (activity.drawState && c.req.valid("query").refresh) {
      const object = activityObject(c.env, id);
      const response = await object.fetch(
        `https://activity.internal/internal/activities/${encodeURIComponent(id)}/refresh`,
        { method: "POST" },
      );
      if (!response.ok) return response;
      return c.json(await getCurrentParticipation(c.env, id, session.user.id));
    }

    return c.json(
      await getCurrentParticipationForActivity(
        c.env,
        activity,
        session.user.id,
      ),
    );
  })
  .get("/me/activities/:id", async (c) => {
    const session = await requireAuth(c);
    const id = c.req.param("id");
    await requireOwnedLdcActivity(c.env, id, session.user.id);
    const stub = activityObject(c.env, id);
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
      await requireOwnedLdcActivity(c.env, id, session.user.id);
      const stub = activityObject(c.env, id);
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
      await requireOwnedLdcActivity(c.env, id, session.user.id);
      const stub = activityObject(c.env, id);
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
      await requireOwnedLdcActivityForDelete(c.env, id, session.user.id);
      const stub = activityObject(c.env, id);
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
      const activity = await requireLdcActivity(c.env, id);
      const { humanToken, ...input } = c.req.valid("json");
      // A token is checked here, not in the 红包's Durable Object, whose
      // writes wait for one another (human-check.ts).
      let humanVerified = false;
      const challenge = humanToken ? humanCheckOf(c.env, activity) : null;
      if (humanToken && challenge)
        humanVerified = await passesHumanCheck(
          c.env,
          challenge,
          humanToken,
          c.req.header("CF-Connecting-IP"),
        );
      const stub = activityObject(c.env, id);
      const response = await stub.fetch(
        `https://activity.internal/internal/activities/${encodeURIComponent(id)}/claim`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            userId: session.user.id,
            ...input,
            humanVerified,
          }),
        },
      );
      if (!response.ok) return response;
      return c.json((await response.json()) as ClaimResult);
    },
  )
  // A running 红包's live channel (live.ts): a WebSocket to its own DO.
  // Signed-in viewers only, from this site's pages only (the browser sends
  // the session cookie with the handshake, and any site can open one).
  // 开奖证明 (docs/draw-proof-design.md): what a v2 红包's random parts came
  // from, for the 🎲 page and anyone checking it. Public, like its roster.
  .get("/activities/:id/proof", async (c) => {
    c.header("Cache-Control", "no-store");
    return c.json(await activityProofData(c.env, c.req.param("id")));
  })
  .get("/activities/:id/live", async (c) => {
    if (c.req.header("Upgrade")?.toLowerCase() !== "websocket")
      return c.json(
        { error: { code: "UPGRADE_REQUIRED", message: "需要 WebSocket 连接" } },
        426,
      );
    assertExactOrigin(c);
    const session = await requireAuth(c);
    const id = c.req.param("id");
    await requireLdcActivity(c.env, id);
    const stub = activityObject(c.env, id);
    // The DO's 101 goes back as it is: a rebuilt one would not upgrade.
    return stub.fetch(
      `https://activity.internal/internal/activities/${encodeURIComponent(id)}/live`,
      {
        headers: { Upgrade: "websocket", [LIVE_USER_HEADER]: session.user.id },
      },
    );
  })
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
  // A payment the upstream turned down for want of the recipient's Credit
  // account: its claimant sends it again (payments/resend.ts).
  .post("/me/claims/:id/resend", async (c) => {
    const session = await requireProtectedMutation(c);
    const id = c.req.param("id");
    await resendClaimPayment(c.env, session.user.id, id);
    return c.json({
      claim: await getClaimDetail(c.env, id, session.user.id),
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
      await requireOwnedLdcActivity(c.env, id, session.user.id);
      const stub = activityObject(c.env, id);
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
