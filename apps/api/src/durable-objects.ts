import { DurableObject } from "cloudflare:workers";
import {
  ACTIVITY_LIMITS,
  claimActivitySchema,
  createActivitySchema,
  deleteActivitySchema,
  endActivitySchema,
  globalRedemptionSchema,
  type ManagedActivity,
  openActivitySchema,
  passwordSolveSchema,
  updateActivitySchema,
} from "@hb/contracts";
import { eq } from "drizzle-orm";
import {
  claimActivity,
  resumePendingActivityClaims,
} from "./activities/claim-service";
import { ActivityError, activityNotFound } from "./activities/errors";
import { endActivity, refreshActivityLifecycle } from "./activities/lifecycle";
import { solveActivityPassword } from "./activities/password-service";
import {
  createActivity,
  deleteActivity,
  getManagedActivity,
  openActivity,
  prepareActivityOpening,
  updateActivity,
} from "./activities/service";
import { findActivity } from "./activities/storage";
import { createDb } from "./db/client";
import { merchants } from "./db/schema";
import {
  discoverGlobalRedemption,
  redeemGlobally,
  refreshGlobalResult,
} from "./discovery/service";
import type { ApiBindings } from "./env";
import { flushPaymentOutbox, runMerchantCycle } from "./payments/scheduler";
import {
  AttemptCooldownError,
  readAttemptCooldown,
} from "./runtime/attempt-cooldown";
import { runMaintenance } from "./scheduled";

type HealthResponse = {
  status: "ok";
  object: "activity" | "merchant";
  storage: "ok";
};

function json(data: HealthResponse, init?: ResponseInit) {
  return Response.json(data, init);
}

async function readActivityJson(request: Request): Promise<unknown> {
  const reader = request.body?.getReader();
  if (!reader)
    throw new ActivityError(400, "INVALID_ACTIVITY", "提交内容必须为有效 JSON");
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > ACTIVITY_LIMITS.requestBytes) {
        await reader.cancel();
        throw new ActivityError(
          413,
          "PAYLOAD_TOO_LARGE",
          "提交内容不能超过 1 MiB",
        );
      }
      chunks.push(new Uint8Array(value));
    }
  } finally {
    reader.releaseLock();
  }
  try {
    return JSON.parse(await new Blob(chunks).text());
  } catch {
    throw new ActivityError(400, "INVALID_ACTIVITY", "提交内容必须为有效 JSON");
  }
}

export class ActivityDO extends DurableObject<ApiBindings> {
  private mutationTail: Promise<void> = Promise.resolve();

  private async serialize<T>(action: () => Promise<T>) {
    const previous = this.mutationTail;
    let release: () => void = () => {};
    this.mutationTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await action();
    } finally {
      release();
    }
  }

  private async scheduleDraw(activityId: string) {
    const row = await findActivity(this.env, activityId);
    if (
      !row ||
      row.openedAt === null ||
      (row.drawState !== "waiting" && row.drawState !== "settling")
    )
      return;
    await this.ctx.storage.put("drawActivityId", activityId);
    const due =
      row.drawState === "settling"
        ? Date.now() + 100
        : Math.max(
            Date.now() + 100,
            Math.min(row.deadline ?? Date.now(), Date.now() + 86_400_000),
          );
    await this.ctx.storage.transaction(async (txn) => {
      const current = await txn.getAlarm();
      if (current === null || due < current) await txn.setAlarm(due);
    });
  }

  async alarm() {
    const id = await this.ctx.storage.get<string>("drawActivityId");
    if (!id) return;
    await this.serialize(async () => {
      const activity = await findActivity(this.env, id);
      if (!activity) {
        await this.ctx.storage.delete("drawActivityId");
        await this.ctx.storage.deleteAlarm();
        return;
      }
      try {
        await refreshActivityLifecycle(this.env, id);
        await resumePendingActivityClaims(this.env, id);
        await flushPaymentOutbox(this.env);
      } catch {
        console.error("activity_draw_recovery_failed", { activityId: id });
        await this.ctx.storage.setAlarm(Date.now() + 5_000);
        return;
      }
      await this.scheduleDraw(id);
    });
  }

  async fetch(request: Request) {
    const url = new URL(request.url);

    if (url.pathname === "/internal/health") {
      const result = this.ctx.storage.sql
        .exec<{ ok: number }>("SELECT 1 AS ok")
        .one();

      if (result.ok !== 1) {
        throw new Error("ActivityDO SQLite health check failed");
      }

      return json({ status: "ok", object: "activity", storage: "ok" });
    }

    if (url.pathname === "/internal/maintenance" && request.method === "POST") {
      if (
        !this.ctx.id.equals(this.env.ACTIVITY_DO.idFromName("maintenance:v1"))
      )
        return Response.json({ error: "INVALID_OBJECT" }, { status: 400 });
      const { scheduledAt } = await request.json<{ scheduledAt: number }>();
      if (!Number.isSafeInteger(scheduledAt) || scheduledAt < 0)
        return Response.json({ error: "INVALID_SCHEDULE" }, { status: 400 });
      const results = await runMaintenance(this.env, scheduledAt);
      const failed = results.some((result) => result.status === "failed");
      return Response.json(
        { status: failed ? "failed" : "ok" },
        { status: failed ? 503 : 200 },
      );
    }

    const isCreation = url.pathname === "/internal/activities/create";
    const isGlobalRedemption =
      url.pathname === "/internal/redemptions/submit" ||
      url.pathname === "/internal/redemptions/discover" ||
      url.pathname === "/internal/redemptions/refresh";
    const route =
      /^\/internal\/activities\/([a-f0-9-]{36})\/(manage|update|open|claim|solve|delete|end|refresh)$/i.exec(
        url.pathname,
      );
    if (
      request.method === "POST" &&
      (isCreation || isGlobalRedemption || route)
    ) {
      const id = route?.[1] ?? "";
      const operation = isCreation ? "create" : route?.[2];
      if (
        !isCreation &&
        !isGlobalRedemption &&
        !this.ctx.id.equals(this.env.ACTIVITY_DO.idFromName(id))
      ) {
        return Response.json(
          { error: { code: "INVALID_OBJECT", message: "活动标识不匹配" } },
          { status: 400 },
        );
      }
      return this.serialize(async () => {
        try {
          if (operation === "refresh") {
            const activity = await findActivity(this.env, id);
            if (!activity) activityNotFound();
            await refreshActivityLifecycle(this.env, id);
            await resumePendingActivityClaims(this.env, id);
            await this.scheduleDraw(id);
            this.ctx.waitUntil(
              flushPaymentOutbox(this.env).catch(() => {
                console.error("activity_draw_outbox_wake_failed", {
                  activityId: id,
                });
              }),
            );
            return Response.json({ status: "ok" });
          }
          let body: unknown;
          try {
            body =
              operation === "create" || operation === "update"
                ? await readActivityJson(request)
                : await request.json();
          } catch (error) {
            if (error instanceof ActivityError) throw error;
            throw new ActivityError(
              400,
              "INVALID_ACTIVITY",
              "提交内容必须为有效 JSON",
            );
          }
          // Large create/update bodies stay intact. Identity comes only from
          // the authenticated HTTP route's internal header, never client JSON.
          if (operation === "create" || operation === "update") {
            const authorId = request.headers.get("X-HB-Actor-ID");
            if (!authorId)
              throw new ActivityError(400, "INVALID_ACTIVITY", "活动作者无效");
            if (
              operation === "create" &&
              !this.ctx.id.equals(
                this.env.ACTIVITY_DO.idFromName(`activity-create:${authorId}`),
              )
            )
              throw new ActivityError(400, "INVALID_OBJECT", "创建账号不匹配");
            const parsed =
              operation === "create"
                ? createActivitySchema.safeParse(body)
                : updateActivitySchema.safeParse(body);
            if (!parsed.success)
              return Response.json(
                {
                  error: {
                    code: "INVALID_ACTIVITY",
                    message: "请检查活动配置",
                    issues: parsed.error.issues.map((issue) => ({
                      path: issue.path.join("."),
                      message: issue.message,
                    })),
                  },
                },
                { status: 400, headers: { "Cache-Control": "no-store" } },
              );
            const activity =
              "requestId" in parsed.data
                ? await createActivity(this.env, authorId, parsed.data)
                : await updateActivity(this.env, id, authorId, parsed.data);
            return Response.json(
              { activity },
              {
                headers: { "Cache-Control": "no-store" },
              },
            );
          }
          if (!body || typeof body !== "object" || Array.isArray(body))
            throw new ActivityError(400, "INVALID_ACTIVITY", "活动请求无效");
          const { authorId, userId, ...input } = body as Record<
            string,
            unknown
          >;
          if (isGlobalRedemption) {
            if (typeof userId !== "string")
              throw new ActivityError(400, "INVALID_ACTIVITY", "兑换请求无效");
            if (
              !this.ctx.id.equals(
                this.env.ACTIVITY_DO.idFromName(`global-redemption:${userId}`),
              )
            )
              throw new ActivityError(400, "INVALID_OBJECT", "兑换账号不匹配");
            if (url.pathname === "/internal/redemptions/refresh") {
              if (
                typeof input.id !== "string" ||
                (input.cursor !== undefined && typeof input.cursor !== "string")
              )
                throw new ActivityError(
                  400,
                  "INVALID_ACTIVITY",
                  "兑换请求无效",
                );
              return Response.json(
                await refreshGlobalResult(
                  this.env,
                  input.id,
                  userId,
                  input.cursor,
                ),
                { headers: { "Cache-Control": "no-store" } },
              );
            }
            const parsed = globalRedemptionSchema.safeParse(input);
            if (!parsed.success)
              throw new ActivityError(400, "INVALID_ACTIVITY", "兑换请求无效");
            if (url.pathname === "/internal/redemptions/discover")
              return Response.json(
                await discoverGlobalRedemption(this.env, userId, parsed.data),
                {
                  headers: { "Cache-Control": "no-store" },
                },
              );
            return Response.json(
              await redeemGlobally(this.env, userId, parsed.data),
              {
                headers: { "Cache-Control": "no-store" },
              },
            );
          }
          if (operation === "solve") {
            const parsed = passwordSolveSchema.safeParse(input);
            if (!parsed.success || typeof userId !== "string")
              throw new ActivityError(
                400,
                "INVALID_ACTIVITY",
                "口令验证请求无效",
              );
            return Response.json(
              {
                ...(await solveActivityPassword(
                  this.env,
                  id,
                  userId,
                  parsed.data,
                )),
                attemptCooldown: await readAttemptCooldown(this.env, userId),
              },
              {
                headers: { "Cache-Control": "no-store" },
              },
            );
          }
          if (operation === "claim") {
            const parsed = claimActivitySchema.safeParse(input);
            if (!parsed.success || typeof userId !== "string")
              throw new ActivityError(400, "INVALID_ACTIVITY", "领取请求无效");
            const result = await claimActivity(
              this.env,
              id,
              userId,
              parsed.data,
            );
            if ("registration" in result) await this.scheduleDraw(id);
            if ("claim" in result && result.claim.rewardType === "ldc") {
              this.ctx.waitUntil(
                flushPaymentOutbox(this.env, result.claim.payment.id).catch(
                  () => {
                    // The committed Outbox and Cron retain responsibility if this wake fails.
                    console.error("payment_claim_wake_failed", {
                      activityId: id,
                    });
                  },
                ),
              );
            }
            return Response.json(
              {
                ...result,
                attemptCooldown: await readAttemptCooldown(this.env, userId),
              },
              {
                headers: { "Cache-Control": "no-store" },
              },
            );
          }
          if (typeof authorId !== "string")
            throw new ActivityError(400, "INVALID_ACTIVITY", "活动作者无效");
          if (operation === "delete") {
            const parsed = deleteActivitySchema.safeParse(input);
            if (!parsed.success)
              throw new ActivityError(400, "INVALID_ACTIVITY", "删除请求无效");
            return Response.json(
              await deleteActivity(this.env, authorId, id, parsed.data.version),
              {
                headers: { "Cache-Control": "no-store" },
              },
            );
          }
          let activity: ManagedActivity;
          if (operation === "manage") {
            await refreshActivityLifecycle(this.env, id);
            activity = await getManagedActivity(this.env, id, authorId);
          } else if (operation === "end") {
            const parsed = endActivitySchema.safeParse(input);
            if (!parsed.success)
              throw new ActivityError(400, "INVALID_ACTIVITY", "结束请求无效");
            activity = await endActivity(
              this.env,
              id,
              authorId,
              parsed.data.version,
            );
          } else {
            const parsed = openActivitySchema.safeParse(input);
            if (!parsed.success)
              throw new ActivityError(400, "INVALID_ACTIVITY", "活动配置无效");
            const check = await prepareActivityOpening(this.env, id, authorId);
            if (check) this.ctx.waitUntil(check());
            activity = await openActivity(
              this.env,
              id,
              authorId,
              parsed.data.version,
              undefined,
              parsed.data,
            );
          }
          await this.scheduleDraw(id);
          return Response.json(
            { activity },
            { headers: { "Cache-Control": "no-store" } },
          );
        } catch (error) {
          if (error instanceof ActivityError) {
            return Response.json(
              {
                error: { code: error.code, message: error.message },
                ...(error instanceof AttemptCooldownError
                  ? { attemptCooldown: error.attemptCooldown }
                  : {}),
              },
              {
                status: error.status,
                headers: {
                  "Cache-Control": "no-store",
                  ...(error instanceof AttemptCooldownError
                    ? { "Retry-After": String(error.retryAfter) }
                    : {}),
                },
              },
            );
          }
          // Never serialize provider errors, SQL parameters or private reward text.
          console.error("activity_mutation_error", {
            errorName: error instanceof Error ? error.name : typeof error,
          });
          return Response.json(
            {
              error: {
                code: "INTERNAL_SERVER_ERROR",
                message: "活动保存失败，请重试",
              },
            },
            { status: 500, headers: { "Cache-Control": "no-store" } },
          );
        }
      });
    }

    return Response.json(
      {
        error: {
          code: "not_found",
          message: "ActivityDO route not found",
        },
      },
      { status: 404 },
    );
  }
}

export class MerchantDO extends DurableObject<ApiBindings> {
  private async run(merchantId: string) {
    const result = await runMerchantCycle(this.env, merchantId);
    if (result.nextRunAt !== null) {
      const due = Math.max(Date.now() + 100, result.nextRunAt);
      await this.ctx.storage.transaction(async (txn) => {
        const current = await txn.getAlarm();
        if (current === null || due < current) await txn.setAlarm(due);
      });
    }
    // An overlapping cycle may already have scheduled newly committed work.
    // A stale empty snapshot must not delete or postpone that wake. An unused
    // alarm will fire once and naturally finish without scheduling another.
    return result;
  }

  async alarm() {
    const merchantId = await this.ctx.storage.get<string>("merchantId");
    if (merchantId) await this.run(merchantId);
  }
  async fetch(request: Request) {
    const url = new URL(request.url);

    if (
      url.pathname === "/internal/payments/run" &&
      request.method === "POST"
    ) {
      const { merchantId } = await request.json<{ merchantId: string }>();
      const row = await createDb(this.env.DB)
        .select()
        .from(merchants)
        .where(eq(merchants.id, merchantId))
        .get();
      const aliases = row
        ? await this.env.DB.prepare(
            "SELECT client_id FROM merchant_client_ids WHERE merchant_id=?",
          )
            .bind(merchantId)
            .all<{ client_id: string }>()
        : null;
      if (
        !row ||
        !aliases?.results.some((alias) =>
          this.ctx.id.equals(this.env.MERCHANT_DO.idFromName(alias.client_id)),
        )
      )
        return Response.json(
          { error: "Merchant identity mismatch" },
          { status: 400 },
        );
      await this.ctx.storage.put("merchantId", merchantId);
      try {
        return Response.json(await this.run(merchantId));
      } catch {
        console.error("merchant_cycle_error", { merchantId });
        return Response.json(
          { error: "Merchant cycle failed" },
          { status: 503 },
        );
      }
    }

    if (url.pathname === "/internal/health") {
      const result = this.ctx.storage.sql
        .exec<{ ok: number }>("SELECT 1 AS ok")
        .one();

      if (result.ok !== 1) {
        throw new Error("MerchantDO SQLite health check failed");
      }

      return json({ status: "ok", object: "merchant", storage: "ok" });
    }

    return Response.json(
      {
        error: {
          code: "not_found",
          message: "MerchantDO route not found",
        },
      },
      { status: 404 },
    );
  }
}
