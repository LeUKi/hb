// 🐟额 for the person (docs/balance-design.md §8, §9.2).
import {
  BALANCE_LIMITS,
  createInviteSchema,
  createTopupSchema,
  createWithdrawalSchema,
  inviteUsernameSchema,
} from "@hb/contracts";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { validator } from "hono/validator";
import { ActivityError } from "../activities/errors";
import {
  getOptionalSession,
  requireAuth,
  requireProtectedMutation,
} from "../auth/session";
import type { ApiContext } from "../env";
import { flushPaymentOutbox } from "../payments/scheduler";
import { requireAppOrigin } from "../security/http";
import {
  acceptInvite,
  createInvite,
  listMyInvites,
  previewInvitee,
  readInvite,
} from "./invites";
import { type BalanceRecordFilter, listRecords, readAccount } from "./ledger";
import { readBalanceSettings, requireBalanceEntry } from "./settings";
import {
  checkOpenTopups,
  checkTopup,
  createTopup,
  ownedTopup,
  payTopup,
  topupView,
} from "./topups";
import {
  createWithdrawal,
  ownedWithdrawal,
  withdrawalDetail,
} from "./withdrawals";

const body = bodyLimit({
  maxSize: 4 * 1024,
  onError: () => {
    throw new ActivityError(413, "PAYLOAD_TOO_LARGE", "提交内容过大");
  },
});

const recordsQuery = validator(
  "query",
  (value): { filter: BalanceRecordFilter; cursor?: string } => {
    const filter = value.filter ?? "all";
    if (
      filter !== "all" &&
      filter !== "topup" &&
      filter !== "withdrawal" &&
      filter !== "adjustment" &&
      filter !== "hongbao"
    )
      throw new ActivityError(400, "INVALID_FILTER", "筛选无效");
    if (value.cursor !== undefined && typeof value.cursor !== "string")
      throw new ActivityError(400, "INVALID_CURSOR", "分页标识无效");
    return { filter, cursor: value.cursor };
  },
);

export const balanceRoutes = new Hono<ApiContext>()
  .use("/me/balance", async (c, next) => {
    c.header("Cache-Control", "no-store");
    await next();
  })
  .use("/me/balance/*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    await next();
  })
  .use("/invites/*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    await next();
  })
  .get("/me/balance", recordsQuery, async (c) => {
    const session = await requireAuth(c);
    const access = await requireBalanceEntry(
      c.env,
      session.user.id,
      session.user.isAdmin,
    );
    const { filter, cursor } = c.req.valid("query");
    const [settings, account, records, pending] = await Promise.all([
      readBalanceSettings(c.env),
      readAccount(c.env, session.user.id),
      listRecords(c.env, session.user.id, filter, cursor),
      c.env.DB.prepare(
        "SELECT COUNT(*) AS count FROM balance_topups WHERE user_id=? AND status!='credited'",
      )
        .bind(session.user.id)
        .first<{ count: number }>(),
    ]);
    return c.json({
      settings: {
        version: settings.version,
        topupEnabled: settings.topupEnabled,
        withdrawEnabled: settings.withdrawEnabled,
        topupFeePercent: settings.topupFeePercent,
        withdrawFeePercent: settings.withdrawFeePercent,
        withdrawMaxMinor: settings.withdrawMaxMinor,
        hongbaoEnabled: settings.hongbaoEnabled,
        topupMinMinor: BALANCE_LIMITS.topupMinMinor,
        topupMaxMinor: BALANCE_LIMITS.topupMaxMinor,
        topupDailyHintMinor: BALANCE_LIMITS.topupDailyHintMinor,
        withdrawMinMinor: BALANCE_LIMITS.withdrawMinMinor,
      },
      account,
      /** What this person may do beyond reading and 转出. */
      access: { topup: access.topup, invite: access.invite },
      /** 转入 not arrived yet (待确认 or 未完成). */
      openTopups: pending?.count ?? 0,
      ...records,
    });
  })
  // The 发红包 form's “从哪发” (docs/balance-design.md §14): shown only
  // while 🐟额红包 are on and there is something to send.
  .get("/me/balance/hongbao", async (c) => {
    const session = await requireAuth(c);
    const [settings, account] = await Promise.all([
      readBalanceSettings(c.env),
      readAccount(c.env, session.user.id),
    ]);
    return c.json({
      available: settings.hongbaoEnabled && account.availableMinor >= 1,
      availableMinor: account.availableMinor,
    });
  })
  .post(
    "/me/balance/topups",
    body,
    validator("json", (value) => {
      const parsed = createTopupSchema.safeParse(value);
      if (!parsed.success)
        throw new ActivityError(400, "INVALID_TOPUP", "请检查转入数量");
      return parsed.data;
    }),
    async (c) => {
      const session = await requireProtectedMutation(c);
      return c.json(
        await createTopup(
          c.env,
          session.user.id,
          c.req.valid("json"),
          requireAppOrigin(c.env),
        ),
      );
    },
  )
  // The page's own check, as it opens: a write, so not inside the read.
  .post("/me/balance/topups/check-open", async (c) => {
    const session = await requireProtectedMutation(c);
    await requireBalanceEntry(c.env, session.user.id, session.user.isAdmin);
    return c.json({ credited: await checkOpenTopups(c.env, session.user.id) });
  })
  .get("/me/balance/topups/:id", async (c) => {
    const session = await requireAuth(c);
    return c.json({
      topup: topupView(
        await ownedTopup(c.env, session.user.id, c.req.param("id")),
      ),
    });
  })
  .post("/me/balance/topups/:id/check", async (c) => {
    const session = await requireProtectedMutation(c);
    const row = await ownedTopup(c.env, session.user.id, c.req.param("id"));
    return c.json({
      topup: topupView(
        row.status === "credited" ? row : await checkTopup(c.env, row, "user"),
      ),
    });
  })
  .post("/me/balance/topups/:id/pay", async (c) => {
    const session = await requireProtectedMutation(c);
    return c.json(await payTopup(c.env, session.user.id, c.req.param("id")));
  })
  .post(
    "/me/balance/withdrawals",
    body,
    validator("json", (value) => {
      const parsed = createWithdrawalSchema.safeParse(value);
      if (!parsed.success)
        throw new ActivityError(400, "INVALID_WITHDRAWAL", "请检查转出数量");
      return parsed.data;
    }),
    async (c) => {
      const session = await requireProtectedMutation(c);
      const { withdrawal, taskId } = await createWithdrawal(
        c.env,
        session.user.id,
        c.req.valid("json"),
        session.user.isAdmin,
      );
      // Its payment starts now; the sweep catches it if this does not.
      if (taskId)
        c.executionCtx.waitUntil(
          flushPaymentOutbox(c.env, taskId).catch(() => {
            console.error("balance_withdrawal_wake_failed", { taskId });
          }),
        );
      return c.json({ withdrawal });
    },
  )
  .get("/me/balance/withdrawals/:id", async (c) => {
    const session = await requireAuth(c);
    return c.json({
      withdrawal: await withdrawalDetail(
        c.env,
        await ownedWithdrawal(c.env, session.user.id, c.req.param("id")),
      ),
    });
  })
  // 邀请 (docs/balance-design.md §13): the dialog on 🐟额, then the link's page.
  .get("/me/balance/invites", async (c) => {
    const session = await requireAuth(c);
    return c.json({ items: await listMyInvites(c.env, session.user.id) });
  })
  .get("/me/balance/invites/preview", async (c) => {
    const session = await requireAuth(c);
    const parsed = inviteUsernameSchema.safeParse(
      c.req.query("username") ?? "",
    );
    if (!parsed.success)
      throw new ActivityError(
        400,
        "INVALID_USERNAME",
        parsed.error.issues[0]?.message ?? "用户名无效",
      );
    return c.json(await previewInvitee(c.env, session.user, parsed.data));
  })
  .post(
    "/me/balance/invites",
    body,
    validator("json", (value) => {
      const parsed = createInviteSchema.safeParse(value);
      if (!parsed.success)
        throw new ActivityError(
          400,
          "INVALID_USERNAME",
          parsed.error.issues[0]?.message ?? "用户名无效",
        );
      return parsed.data;
    }),
    async (c) => {
      const session = await requireProtectedMutation(c);
      return c.json(
        await createInvite(
          c.env,
          session.user,
          c.req.valid("json").username,
          requireAppOrigin(c.env),
        ),
      );
    },
  )
  // Open to anyone with the link: who sent it, and what this viewer can do.
  .get("/invites/:token", async (c) => {
    const session = await getOptionalSession(c);
    return c.json(
      await readInvite(
        c.env,
        c.req.param("token"),
        session ? session.user : null,
      ),
    );
  })
  .post("/invites/:token/accept", async (c) => {
    const session = await requireProtectedMutation(c);
    return c.json(
      await acceptInvite(c.env, c.req.param("token"), session.user),
    );
  });
