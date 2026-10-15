import {
  createMerchantSchema,
  repairPaymentCredentialSchema,
  simulationScenarioSchema,
  updateMerchantSchema,
} from "@hb/contracts";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { validator } from "hono/validator";
import { z } from "zod";
import { ActivityError } from "../activities/errors";
import { requireAuth, requireProtectedMutation } from "../auth/session";
import type { ApiContext } from "../env";
import { isLocalSimulation } from "../runtime/controls";
import { accountPaymentDetail, listAccountPayments } from "./account-queries";
import { readMerchantImpact, readMerchantUsage } from "./configuration";
import {
  createMerchant,
  getMerchant,
  listMerchants,
  ownedMerchant,
  repairPaymentCredential,
  updateMerchant,
} from "./merchants";
import { listMerchantPayments, merchantPaymentDetail } from "./queries";
import { beginCredentialVerification } from "./verification";

function valid<T>(result: z.ZodSafeParseResult<T>): T {
  if (!result.success)
    throw new ActivityError(400, "INVALID_MERCHANT", "请检查商户配置");
  return result.data;
}
const cursorQuery = validator("query", (value): { cursor?: string } => {
  if (value.cursor !== undefined && typeof value.cursor !== "string")
    throw new ActivityError(400, "INVALID_CURSOR", "分页标识无效");
  return { cursor: value.cursor };
});
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const accountPaymentQuery = validator(
  "query",
  (
    value,
  ): {
    status: "all" | "open" | "confirmed";
    activity?: string;
    cursor?: string;
  } => {
    const status = value.status ?? "all";
    if (status !== "all" && status !== "open" && status !== "confirmed")
      throw new ActivityError(400, "INVALID_STATUS", "付款状态无效");
    if (
      value.activity !== undefined &&
      (typeof value.activity !== "string" || !uuidPattern.test(value.activity))
    )
      throw new ActivityError(400, "INVALID_ACTIVITY", "红包标识无效");
    if (value.cursor !== undefined && typeof value.cursor !== "string")
      throw new ActivityError(400, "INVALID_CURSOR", "分页标识无效");
    return { status, activity: value.activity, cursor: value.cursor };
  },
);
const body = bodyLimit({
  maxSize: 16 * 1024,
  onError: () => {
    throw new ActivityError(413, "PAYLOAD_TOO_LARGE", "提交内容过大");
  },
});

export const merchantRoutes = new Hono<ApiContext>()
  .use("*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    await next();
  })
  .get("/me/merchants", cursorQuery, async (c) => {
    const session = await requireAuth(c);
    return c.json(
      await listMerchants(c.env, session.user.id, c.req.valid("query").cursor),
    );
  })
  .post(
    "/me/merchants",
    body,
    validator("json", (value) => valid(createMerchantSchema.safeParse(value))),
    async (c) => {
      const session = await requireProtectedMutation(c);
      const merchant = await createMerchant(
        c.env,
        session.user.id,
        c.req.valid("json"),
      );
      if (
        merchant.mode === "real" &&
        merchant.credentialVerification.status === "unverified"
      ) {
        const job = await beginCredentialVerification(c.env, merchant.id);
        if (job) c.executionCtx.waitUntil(job());
      }
      return c.json({
        merchant: await getMerchant(c.env, merchant.id, session.user.id),
      });
    },
  )
  .get("/me/merchants/:id", async (c) => {
    const session = await requireAuth(c);
    return c.json({
      merchant: await getMerchant(c.env, c.req.param("id"), session.user.id),
    });
  })
  .get("/me/merchants/:id/usage", async (c) => {
    const session = await requireAuth(c);
    const row = await ownedMerchant(c.env, c.req.param("id"), session.user.id);
    return c.json(await readMerchantUsage(c.env, row.id));
  })
  .get("/me/merchants/:id/change-impact", async (c) => {
    const session = await requireAuth(c);
    const row = await ownedMerchant(c.env, c.req.param("id"), session.user.id);
    const { impact, confirmationToken } = await readMerchantImpact(c.env, row);
    return c.json({ impact, confirmationToken });
  })
  .post(
    "/me/merchants/:id/payments/:taskId/credentials",
    body,
    validator("json", (value) =>
      valid(repairPaymentCredentialSchema.safeParse(value)),
    ),
    async (c) => {
      const session = await requireProtectedMutation(c);
      const id = c.req.param("id"),
        taskId = c.req.param("taskId");
      const result = await repairPaymentCredential(
        c.env,
        id,
        session.user.id,
        taskId,
        c.req.valid("json"),
      );
      const job = await beginCredentialVerification(
        c.env,
        id,
        undefined,
        result.credentialVersion,
      );
      if (job)
        c.executionCtx.waitUntil(
          job().then(() => wakeMerchant(c.env, result.merchant)),
        );
      return c.json({
        merchant: await getMerchant(c.env, id, session.user.id),
        payment: await merchantPaymentDetail(c.env, id, taskId),
      });
    },
  )
  .patch(
    "/me/merchants/:id",
    body,
    validator("json", (value) => valid(updateMerchantSchema.safeParse(value))),
    async (c) => {
      const session = await requireProtectedMutation(c);
      const id = c.req.param("id");
      const merchant = await updateMerchant(
        c.env,
        id,
        session.user.id,
        c.req.valid("json"),
      );
      if (c.req.valid("json").secret !== undefined) {
        if (merchant.mode === "real") {
          const job = await beginCredentialVerification(
            c.env,
            id,
            undefined,
            merchant.appliedChange.credentialVersion,
          );
          if (job)
            c.executionCtx.waitUntil(
              job().then(() => wakeMerchant(c.env, merchant)),
            );
        } else c.executionCtx.waitUntil(wakeMerchant(c.env, merchant));
      }
      return c.json({
        merchant: {
          ...(await getMerchant(c.env, id, session.user.id)),
          appliedChange: merchant.appliedChange,
        },
      });
    },
  )
  .post(
    "/me/merchants/:id/simulation",
    body,
    validator("json", (value) =>
      valid(
        z.strictObject({ scenario: simulationScenarioSchema }).safeParse(value),
      ),
    ),
    async (c) => {
      const session = await requireProtectedMutation(c);
      if (!isLocalSimulation(c.env))
        throw new ActivityError(404, "NOT_FOUND", "未找到此功能");
      const id = c.req.param("id");
      const row = await ownedMerchant(c.env, id, session.user.id);
      if (row.mode !== "simulation")
        throw new ActivityError(400, "NOT_SIMULATION", "此商户不是模拟配置");
      await c.env.DB.prepare(
        `UPDATE simulation_controls SET scenario=?,updated_at=? WHERE merchant_id=?`,
      )
        .bind(c.req.valid("json").scenario, Date.now(), id)
        .run();
      return c.json({
        merchant: await getMerchant(c.env, id, session.user.id),
      });
    },
  )
  // Every payment of the account's 红包, grouped by 红包 (/payments, 🧾).
  .get("/me/payments", accountPaymentQuery, async (c) => {
    const session = await requireAuth(c);
    const query = c.req.valid("query");
    return c.json(
      await listAccountPayments(
        c.env,
        session.user.id,
        query.status,
        query.activity,
        query.cursor,
      ),
    );
  })
  .get("/me/payments/:taskId", cursorQuery, async (c) => {
    const session = await requireAuth(c);
    return c.json(
      await accountPaymentDetail(
        c.env,
        session.user.id,
        c.req.param("taskId"),
        c.req.valid("query").cursor,
      ),
    );
  })
  .get("/me/merchants/:id/payments", cursorQuery, async (c) => {
    const session = await requireAuth(c);
    const id = c.req.param("id");
    await ownedMerchant(c.env, id, session.user.id);
    return c.json(
      await listMerchantPayments(c.env, id, c.req.valid("query").cursor),
    );
  })
  .get("/me/merchants/:id/payments/:taskId", cursorQuery, async (c) => {
    const session = await requireAuth(c);
    const id = c.req.param("id");
    await ownedMerchant(c.env, id, session.user.id);
    return c.json({
      payment: await merchantPaymentDetail(
        c.env,
        id,
        c.req.param("taskId"),
        c.req.valid("query").cursor,
      ),
    });
  });

async function wakeMerchant(
  env: ApiContext["Bindings"],
  merchant: { id: string; clientId: string },
) {
  const response = await env.MERCHANT_DO.get(
    env.MERCHANT_DO.idFromName(merchant.clientId),
  ).fetch("https://merchant.internal/internal/payments/run", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ merchantId: merchant.id }),
  });
  await response.arrayBuffer();
  if (!response.ok)
    throw new ActivityError(
      503,
      "MERCHANT_BUSY",
      "付款处理暂未完成，系统会自动继续",
    );
}
