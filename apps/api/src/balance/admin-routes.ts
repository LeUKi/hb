// 网站管理 · 🐟额 (docs/balance-design.md §7, §9.2). Writes check the exact
// Origin, the session, CSRF and the admin, in that order.
import {
  balanceAdjustmentSchema,
  confirmTopupSchema,
  createInviteLinkSchema,
  savePlatformAppSchema,
  updateBalanceSettingsSchema,
} from "@hb/contracts";
import type { Context } from "hono";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { HTTPException } from "hono/http-exception";
import type { z } from "zod";
import { ActivityError } from "../activities/errors";
import { ActivityValidationError } from "../activities/routes";
import { requireAdmin, requireProtectedMutation } from "../auth/session";
import type { ApiContext } from "../env";
import { beginCredentialVerification } from "../payments/verification";
import { requireAppOrigin } from "../security/http";
import {
  adminBalanceOverview,
  adminTopupDetail,
  adminUserBalance,
  adminWithdrawalDetail,
  listAdminAdjustments,
  listAdminAttention,
  listAdminTopups,
  listAdminWithdrawals,
} from "./admin";
import { balanceError } from "./errors";
import {
  createInviteLink,
  listAdminInvites,
  listAdminMembers,
  listInviteLinks,
  stopInviteLink,
} from "./invites";
import { adjustBalance, decodeRecordCursor } from "./ledger";
import {
  platformAppView,
  readPlatformApp,
  readPlatformAppRow,
  savePlatformApp,
} from "./platform-app";
import {
  readBalanceSettings,
  recentBalanceSettingChanges,
  updateBalanceSettings,
} from "./settings";
import { checkTopup, confirmTopup, readTopup, topupView } from "./topups";

const body = bodyLimit({
  maxSize: 32 * 1024,
  onError: () => {
    throw new ActivityError(413, "PAYLOAD_TOO_LARGE", "提交内容过大");
  },
});

async function adminMutation(c: Context<ApiContext>) {
  const session = await requireProtectedMutation(c);
  if (!session.user.isAdmin)
    throw new HTTPException(403, { message: "此页面仅限管理员访问" });
  return session;
}

async function parsed<T extends z.ZodType>(
  c: Context<ApiContext>,
  schema: T,
): Promise<z.infer<T>> {
  const result = schema.safeParse(await c.req.json().catch(() => null));
  if (!result.success)
    throw new ActivityValidationError(
      result.error.issues.map((issue) => ({
        path: issue.path.join("."),
        message: issue.message,
      })),
    );
  return result.data;
}

function cursorOf(c: Context<ApiContext>) {
  const cursor = c.req.query("cursor");
  return cursor === undefined || cursor === "" ? undefined : cursor;
}

export const balanceAdminRoutes = new Hono<ApiContext>()
  .use("/admin/balance/*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    await requireAdmin(c);
    await next();
  })
  .get("/admin/balance/overview", async (c) =>
    c.json(await adminBalanceOverview(c.env)),
  )
  .get("/admin/balance/topups", async (c) => {
    const view = c.req.query("view") ?? "attention";
    if (view !== "attention" && view !== "all")
      throw new ActivityError(400, "INVALID_VIEW", "筛选无效");
    return c.json(await listAdminTopups(c.env, view, cursorOf(c)));
  })
  .get("/admin/balance/topups/:id", async (c) => {
    const detail = await adminTopupDetail(c.env, c.req.param("id"));
    if (!detail) balanceError(404, "TOPUP_NOT_FOUND", "没有找到这笔转入");
    return c.json(detail);
  })
  .post("/admin/balance/topups/:id/check", async (c) => {
    await adminMutation(c);
    const row = await readTopup(c.env, c.req.param("id"));
    if (!row) balanceError(404, "TOPUP_NOT_FOUND", "没有找到这笔转入");
    return c.json({ topup: topupView(await checkTopup(c.env, row, "admin")) });
  })
  .post("/admin/balance/topups/:id/confirm", body, async (c) => {
    const session = await adminMutation(c);
    const { reason } = await parsed(c, confirmTopupSchema);
    return c.json({
      topup: topupView(
        await confirmTopup(c.env, session.user.id, c.req.param("id"), reason),
      ),
    });
  })
  .get("/admin/balance/attention", async (c) =>
    c.json(await listAdminAttention(c.env, cursorOf(c))),
  )
  .get("/admin/balance/withdrawals", async (c) => {
    const view = c.req.query("view") ?? "all";
    if (view !== "attention" && view !== "all")
      throw new ActivityError(400, "INVALID_VIEW", "筛选无效");
    return c.json(await listAdminWithdrawals(c.env, view, cursorOf(c)));
  })
  .get("/admin/balance/withdrawals/:id", async (c) => {
    const detail = await adminWithdrawalDetail(c.env, c.req.param("id"));
    if (!detail) balanceError(404, "WITHDRAWAL_NOT_FOUND", "没有找到这笔转出");
    return c.json(detail);
  })
  .get("/admin/balance/members", async (c) =>
    c.json(await listAdminMembers(c.env, decodeRecordCursor(cursorOf(c)))),
  )
  .get("/admin/balance/invites", async (c) =>
    c.json(await listAdminInvites(c.env, decodeRecordCursor(cursorOf(c)))),
  )
  // 通用链接 (docs/balance-design.md §13): the link is in the answer only.
  .get("/admin/balance/invite-links", async (c) =>
    c.json(await listInviteLinks(c.env, decodeRecordCursor(cursorOf(c)))),
  )
  .post("/admin/balance/invite-links", body, async (c) => {
    const session = await adminMutation(c);
    const input = await parsed(c, createInviteLinkSchema);
    return c.json(
      await createInviteLink(
        c.env,
        session.user.id,
        input,
        requireAppOrigin(c.env),
      ),
    );
  })
  .post("/admin/balance/invite-links/:id/stop", async (c) => {
    const session = await adminMutation(c);
    return c.json(
      await stopInviteLink(c.env, session.user.id, c.req.param("id")),
    );
  })
  .get("/admin/balance/adjustments", async (c) =>
    c.json(await listAdminAdjustments(c.env, cursorOf(c))),
  )
  .get("/admin/balance/users/:id", async (c) =>
    c.json(await adminUserBalance(c.env, c.req.param("id"), cursorOf(c))),
  )
  .post("/admin/balance/users/:id/adjustments", body, async (c) => {
    const session = await adminMutation(c);
    const input = await parsed(c, balanceAdjustmentSchema);
    return c.json({
      adjustment: await adjustBalance(
        c.env,
        session.user.id,
        c.req.param("id"),
        input,
      ),
    });
  })
  .get("/admin/balance/settings", async (c) => {
    const [settings, recentChanges, platformApp] = await Promise.all([
      readBalanceSettings(c.env),
      recentBalanceSettingChanges(c.env),
      readPlatformApp(c.env),
    ]);
    return c.json({ settings, recentChanges, platformApp });
  })
  .patch("/admin/balance/settings", body, async (c) => {
    const session = await adminMutation(c);
    const input = await parsed(c, updateBalanceSettingsSchema);
    return c.json({
      settings: await updateBalanceSettings(c.env, session.user.id, input),
    });
  })
  .put("/admin/balance/platform-app", body, async (c) => {
    const session = await adminMutation(c);
    const input = await parsed(c, savePlatformAppSchema);
    const row = await savePlatformApp(c.env, session.user.id, input);
    const job = await beginCredentialVerification(c.env, row.id);
    if (job) c.executionCtx.waitUntil(job());
    return c.json({ platformApp: await platformAppView(c.env, row) });
  })
  // 重新检查: the key again, when Credit could not be reached.
  .post("/admin/balance/platform-app/check", async (c) => {
    await adminMutation(c);
    const row = await readPlatformAppRow(c.env);
    if (!row) balanceError(404, "PLATFORM_APP_NOT_FOUND", "还没有平台应用");
    const job = await beginCredentialVerification(c.env, row.id);
    if (job) c.executionCtx.waitUntil(job());
    return c.json({ platformApp: await platformAppView(c.env, row) });
  });
